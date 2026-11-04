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
// dels: id → 被删 key 的值（删后重加要靠它判定「KV 里那条到底是不是同一条」）
const pending = { adds: new Map(), dels: new Map() };

function overlay(rows) {
  const out = rows.filter((r) => !pending.dels.has(r.id));
  for (const [id, rec] of pending.adds) {
    if (!out.some((r) => r.id === id)) out.push(rec);
  }
  return out;
}

/**
 * KV 已经反映了某条写入时，把它从覆盖层摘掉。
 *
 * 对删除标记：只要 KV 里该 id 不存在就说明删除已生效，可以摘掉标记。
 * 「删除后又被加回、新写入还没传播」这种情况由 addKeys 在 put 成功后
 * 主动 pending.dels.delete(id) 处理，不指望这里区分 —— 那样会把删除标记永久留下。
 */
function settle(kvRows) {
  const ids = new Set(kvRows.map((r) => r.id));
  for (const id of [...pending.adds.keys()]) if (ids.has(id)) pending.adds.delete(id);
  for (const id of [...pending.dels.keys()]) if (!ids.has(id)) pending.dels.delete(id);
}

/**
 * 直读 KV（不走缓存、不叠覆盖层），写入路径用它当基底。
 *
 * 读失败必须抛错，不能吞成 []：addKeys / removeKey 都以它的返回值当写基底，
 * 一旦把「读失败」当成「池是空的」写回去，一次瞬态 KV 故障就会把整个动态号池
 * 覆盖成「只剩本次新增」，而且接口还会返回 ok，用户毫无察觉。
 * 读路径（dynamicKeys）自己捕获异常并退回上一份缓存，不在这里兜。
 */
async function readRaw(env) {
  if (!env.KEYS_KV) return [];
  const raw = await env.KEYS_KV.get(KV_POOL, "json");
  return Array.isArray(raw) ? await toRecords(raw) : [];
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
    // 去重用的是 trim 后的值，写出去也必须是 trim 后的值：
    // 否则手工用 wrangler kv key put 写入带尾随空白的 key，
    // 会拼成 `Bearer gsk_xxx `（带空格）→ 上游 401 → 被当成失效 key 摘掉。
    out.push(typeof item === "string" ? v : { ...item, k: v });
  }
  return out;
}

/** Secret 里的静态 key（部署时写入） */
export function staticKeys(env) {
  return norm((env.GROQ_KEYS || "").split(/[,\s]+/)).map((s) => ({ k: s, id: null, added: null }));
}

/**
 * 把 KV 里的条目统一成记录形状 {id, k, added}。
 * KV 里可能存的是纯字符串（早期版本、或用 wrangler kv key put 手工写），
 * 不补 id 的话 pool() 取 x.k 会拿到 undefined，整条 key 被静默丢掉。
 */
async function toRecords(list) {
  return Promise.all(
    norm(list).map(async (item) =>
      typeof item === "string"
        ? { id: await keyId(item), k: item, added: null }
        : { id: item.id || (await keyId(item.k)), k: item.k, added: item.added || null },
    ),
  );
}

/** KV 里的动态 key（管理台添加）。fresh=true 绕过 isolate 缓存直读 KV */
export async function dynamicKeys(env, { fresh = false } = {}) {
  if (!env.KEYS_KV) return [];
  const now = Date.now();
  if (!fresh && now - cache.at < KV_TTL_MS) return overlay(cache.list);
  let list;
  try {
    const raw = await env.KEYS_KV.get(KV_POOL, "json");
    list = Array.isArray(raw) ? await toRecords(raw) : [];
  } catch (_) {
    // 读失败：退回上一份缓存，且不刷新 cache.at，让下次请求继续重试；
    // 把 [] 写进缓存会让动态 key 整整 30 秒从号池里消失。
    return overlay(cache.list);
  }
  settle(list);
  cache = { at: now, list };
  return overlay(list);
}

/** 合并后的完整号池（纯 key 字符串数组，顺序：静态在前，动态在后） */
export async function pool(env) {
  const s = staticKeys(env).map((x) => x.k);
  const d = (await dynamicKeys(env)).map((x) => x.k);
  const seen = new Set();
  const out = [];
  for (const k of [...s, ...d]) {
    if (typeof k !== "string" || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
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
  const fresh = [];

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
    fresh.push(rec);
    added.push({ id: rec.id, key: mask(k) });
  }

  if (added.length) {
    const next = norm(merged);
    // 先落 KV 再更新覆盖层：put 抛错时不能留下「只有本 isolate 认为加了」的状态，
    // 否则后续 add/delete 都会拿这条幻影记录当基底继续写。
    await env.KEYS_KV.put(KV_POOL, JSON.stringify(next));
    for (const rec of fresh) {
      pending.dels.delete(rec.id); // 删后重加：以本次新增为准
      if (pending.adds.size >= PENDING_MAX) pending.adds.delete(pending.adds.keys().next().value);
      pending.adds.set(rec.id, rec);
    }
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

  const target = merged.find((x) => x.id === id);
  const next = merged.filter((x) => x.id !== id);
  if (!target) return { removed: false };
  await env.KEYS_KV.put(KV_POOL, JSON.stringify(next));
  pending.adds.delete(id);
  // 记删除标记时保留 key 值（排查时有据可查）。同 isolate 上「删完立刻加回」的
  // 场景由 addKeys 在 put 成功后 pending.dels.delete(id) 收尾，不依赖这里的值。
  if (pending.dels.size >= PENDING_MAX) pending.dels.delete(pending.dels.keys().next().value);
  pending.dels.set(id, target.k);
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
