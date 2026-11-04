/**
 * groq-proxy 号池状态 —— worker.js 与 admin.js 共用
 *
 * 号池来源有两个：
 *  1. Secret GROQ_KEYS（逗号/空白分隔）—— 部署时写死，改要重新 wrangler secret put
 *  2. KV KEYS_KV 的 "pool" 键 —— 管理台运行时自助增删，无需重新部署
 *
 * KV 读取按 isolate 缓存 30s；写入后立即刷新本 isolate 的缓存，
 * 因此同一个 isolate 内的增删是立即可见的，跨 isolate 最长 30s 后生效。
 */

const KV_POOL = "pool";
const KV_TTL_MS = 30_000;

// 覆盖层条目上限：人工增删量级远达不到，纯粹防异常循环把内存撑大
const PENDING_MAX = 500;

const enc = new TextEncoder();

let cache = { at: 0, list: [] };

/**
 * KV 是最终一致的：写入后同一 isolate 立即读得到（走本地缓存），
 * 但跨 colo 的读最长要 60 秒才看到。为了让「刚加完就生效」在管理台上成立，
 * 这里维护一份本 isolate 的写入覆盖层，KV 追上来后自动丢弃。
 */
const pending = { adds: new Map(), dels: new Set() };

function overlay(rows) {
  const out = rows.filter((r) => !pending.dels.has(r.id));
  for (const [id, rec] of pending.adds) {
    if (!out.some((r) => r.id === id)) out.push(rec);
  }
  return out;
}

/** KV 已经反映了某条写入时，把它从覆盖层摘掉 */
function settle(kvRows) {
  const ids = new Set(kvRows.map((r) => r.id));
  for (const id of [...pending.adds.keys()]) if (ids.has(id)) pending.adds.delete(id);
  for (const id of [...pending.dels]) if (!ids.has(id)) pending.dels.delete(id);
}

/** 直读 KV（不走缓存、不叠覆盖层），写入路径用它当基底 */
async function readRaw(env) {
  if (!env.KEYS_KV) return [];
  try {
    const raw = await env.KEYS_KV.get(KV_POOL, "json");
    return Array.isArray(raw) ? norm(raw) : [];
  } catch (_) {
    return [];
  }
}

function norm(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = typeof item === "string" ? item : item?.k;
    if (typeof k !== "string") continue;
    const v = k.trim();
    if (!v.startsWith("gsk_") || v.length < 20) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(item);
  }
  return out;
}

/** Secret 里的静态 key（部署时写入） */
export function staticKeys(env) {
  return norm((env.GROQ_KEYS || "").split(/[,\s]+/)).map((s) => ({ k: s, id: null, added: null }));
}

/** KV 里的动态 key（管理台添加）。fresh=true 绕过 isolate 缓存直读 KV */
export async function dynamicKeys(env, { fresh = false } = {}) {
  if (!env.KEYS_KV) return [];
  const now = Date.now();
  if (!fresh && now - cache.at < KV_TTL_MS) return overlay(cache.list);
  let list = [];
  try {
    const raw = await env.KEYS_KV.get(KV_POOL, "json");
    list = Array.isArray(raw) ? norm(raw) : [];
  } catch (_) {
    list = [];
  }
  settle(list);
  cache = { at: now, list };
  return overlay(list);
}

/** 合并后的完整号池（纯 key 字符串数组，顺序：静态在前，动态在后） */
export async function pool(env) {
  const s = staticKeys(env).map((x) => x.k);
  const d = (await dynamicKeys(env)).map((x) => x.k);
  return norm([...s, ...d]).map((x) => (typeof x === "string" ? x : x.k));
}

/** 带元信息的号池视图（管理台用） */
export async function poolDetail(env) {
  const s = staticKeys(env);
  const d = await dynamicKeys(env, { fresh: true });
  const seen = new Set();
  const rows = [];
  for (const x of s) {
    if (seen.has(x.k)) continue;
    seen.add(x.k);
    rows.push({ id: null, key: x.k, source: "secret", added: null });
  }
  for (const x of d) {
    if (seen.has(x.k)) continue;
    seen.add(x.k);
    rows.push({ id: x.id, key: x.k, source: "kv", added: x.added || null });
  }
  return rows;
}

export function mask(k) {
  return k ? `gsk_...${k.slice(-4)}` : "";
}

/** 恒定时间字符串比较：避免用 !== 比对令牌时的时序侧信道 */
export function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function keyId(key) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
  return [...new Uint8Array(buf)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 批量添加。返回 { added, duplicate, invalid }
 * 只校验格式，不探活（探活交给管理台的「探活」按钮，避免添加时等太久）
 */
export async function addKeys(env, text) {
  if (!env.KEYS_KV) throw new Error("未绑定 KEYS_KV");
  const incoming = String(text || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const existing = new Set((await pool(env)).map((k) => k));
  // 写前取 KV 真实内容 + 本地未落定的写入，避免用陈旧快照覆盖别人的新增
  const base = await readRaw(env);
  const seenId = new Set(base.map((r) => r.id));
  const merged = [...base];
  for (const [id, rec] of pending.adds) if (!seenId.has(id)) merged.push(rec);

  const added = [];
  const duplicate = [];
  const invalid = [];

  for (const k of incoming) {
    if (!k.startsWith("gsk_") || k.length < 20) {
      invalid.push(k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);
      continue;
    }
    if (existing.has(k)) {
      duplicate.push(mask(k));
      continue;
    }
    existing.add(k);
    const rec = { id: await keyId(k), k, added: new Date().toISOString() };
    merged.push(rec);
    if (pending.adds.size >= PENDING_MAX) pending.adds.delete(pending.adds.keys().next().value);
    pending.adds.set(rec.id, rec);
    added.push({ id: rec.id, key: mask(k) });
  }

  if (added.length) {
    const next = norm(merged);
    await env.KEYS_KV.put(KV_POOL, JSON.stringify(next));
    cache = { at: Date.now(), list: next };
  }
  return { added, duplicate, invalid };
}

/** 按 id 删除（只能删 KV 里的，Secret 里的删不掉） */
export async function removeKey(env, id) {
  if (!env.KEYS_KV) throw new Error("未绑定 KEYS_KV");
  const base = await readRaw(env);
  const seenId = new Set(base.map((r) => r.id));
  const merged = [...base];
  for (const [pid, rec] of pending.adds) if (!seenId.has(pid)) merged.push(rec);

  const next = merged.filter((x) => x.id !== id);
  if (next.length === merged.length) return { removed: false };
  await env.KEYS_KV.put(KV_POOL, JSON.stringify(next));
  pending.adds.delete(id);
  if (pending.dels.size >= PENDING_MAX) pending.dels.delete(pending.dels.values().next().value);
  pending.dels.add(id);
  cache = { at: Date.now(), list: norm(next) };
  return { removed: true };
}

/** 清空 KV 里的动态 key（不影响 Secret） */
export async function clearDynamic(env) {
  if (!env.KEYS_KV) throw new Error("未绑定 KEYS_KV");
  await env.KEYS_KV.delete(KV_POOL);
  pending.adds.clear();
  cache = { at: Date.now(), list: [] };
}
