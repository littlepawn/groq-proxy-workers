/**
 * pool.js 行为测试：用假 KV 模拟，含「KV 最终一致读不到写入」的场景
 */
import test from "node:test";
import assert from "node:assert/strict";

function fakeKV({ stale = false } = {}) {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      if (!stale) store.set(k, v);
      // stale=true 模拟「写成功但 eigenen 读到旧值」的极端情况
    },
    async delete(k) { store.delete(k); },
  };
}

async function fresh() { return import(`../src/pool.js?t=${Math.random()}`); }

const K1 = "gsk_TESTAAAA111122223333";
const K2 = "gsk_TESTBBBB111122223333";
const K3 = "gsk_TESTCCCC111122223333";

test("格式校验：非 gsk_ 前缀、过短、空白垃圾全部归 invalid", async () => {
  const kv = fakeKV();
  const p = await fresh();
  const r = await p.addKeys({ GROQ_KEYS: K1, KEYS_KV: kv }, `not-a-key, gsk_short, ${K2}\n\n ,`);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.equal(r.duplicate.length, 0);
});

test("重复检测：Secret 里已有的 key 不能重复加入", async () => {
  const kv = fakeKV();
  const p = await fresh();
  const r = await p.addKeys({ GROQ_KEYS: K1, KEYS_KV: kv }, `${K1},${K2}`);
  assert.equal(r.added.length, 1, "只有 K2 应被加入");
  assert.equal(r.duplicate.length, 1);
  // 再加一次 K2 → 重复
  const r2 = await p.addKeys({ GROQ_KEYS: K1, KEYS_KV: kv }, K2);
  assert.equal(r2.added.length, 0);
  assert.equal(r2.duplicate.length, 1);
});

test("同一批次里重复粘贴只入池一次", async () => {
  const kv = fakeKV();
  const p = await fresh();
  const r = await p.addKeys({ GROQ_KEYS: "", KEYS_KV: kv }, `${K2},${K2},${K2}`);
  assert.equal(r.added.length, 1);
  assert.equal(r.duplicate.length, 2);
});

test("KV 写入后读不到（最终一致）时，覆盖层仍让它立即可见", async () => {
  const kv = fakeKV({ stale: true });
  const p = await fresh();
  const env = { GROQ_KEYS: K1, KEYS_KV: kv };
  await p.addKeys(env, K2);
  const keys = await p.pool(env);
  assert.deepEqual(keys, [K1, K2], "刚加的 key 必须立刻参与轮询");
  const detail = await p.poolDetail(env);
  assert.equal(detail.length, 2);
  assert.equal(detail[1].source, "kv");
});

test("按 id 删除：删掉后立刻从池里消失，且删得掉覆盖层里的条目", async () => {
  const kv = fakeKV({ stale: true });
  const p = await fresh();
  const env = { GROQ_KEYS: K1, KEYS_KV: kv };
  const r = await p.addKeys(env, K2);
  const id = r.added[0].id;
  const del = await p.removeKey(env, id);
  assert.equal(del.removed, true);
  assert.deepEqual(await p.pool(env), [K1]);
  // 再删一次 → false
  assert.equal((await p.removeKey(env, id)).removed, false);
});

test("Secret 里的静态 key 不可删（没有 id）", async () => {
  const kv = fakeKV();
  const p = await fresh();
  const env = { GROQ_KEYS: K1, KEYS_KV: kv };
  const detail = await p.poolDetail(env);
  assert.equal(detail[0].id, null);
  assert.equal(detail[0].source, "secret");
  assert.equal((await p.removeKey(env, null)).removed, false);
});

test("无 KEYS_KV 时退化为只用 Secret，增删报错", async () => {
  const p = await fresh();
  const env = { GROQ_KEYS: `${K1},${K2}` };
  assert.deepEqual(await p.pool(env), [K1, K2]);
  await assert.rejects(() => p.addKeys(env, K3), /未绑定 KEYS_KV/);
});

test("KV 里存了脏数据（字符串/超短/重复）时 norm 过滤", async () => {
  const kv = fakeKV();
  kv.store.set("pool", JSON.stringify(["gsk_bad", K2, { k: K2 }, { k: "gsk_" }, 123]));
  const p = await fresh();
  const keys = await p.pool({ GROQ_KEYS: "", KEYS_KV: kv });
  assert.deepEqual(keys, [K2], "纯字符串条目不能被静默丢掉");
  const detail = await p.poolDetail({ GROQ_KEYS: "", KEYS_KV: kv });
  assert.equal(detail.length, 1);
  assert.equal(detail[0].source, "kv");
  assert.match(detail[0].id, /^[0-9a-f]{8}$/, "纯字符串条目要补出可删除的 id");
});

test("safeEqual：等长不同、越界长度、空串都返回 false", async () => {
  const p = await fresh();
  assert.equal(p.safeEqual("abc", "abc"), true);
  assert.equal(p.safeEqual("abc", "abd"), false);
  assert.equal(p.safeEqual("abc", "abcd"), false);
  assert.equal(p.safeEqual("", ""), false);
  assert.equal(p.safeEqual(undefined, "x"), false);
});

test("mask 只露尾 4 位", async () => {
  const p = await fresh();
  assert.equal(p.mask(K1), "gsk_...3333");
  assert.equal(p.mask(""), "");
});

test("keyId 稳定且不泄露原文", async () => {
  const p = await fresh();
  const a = await p.keyId(K1);
  const b = await p.keyId(K1);
  assert.equal(a, b);
  assert.equal(a.length, 8);
  assert.equal(a.includes("3333"), false);
});

// ── 回归：审查发现的号池状态机缺陷（2026-11-05）─────────────────────────

test("回归#2 删除后立刻重新加入同一把 key，覆盖层不能把它吞掉", async () => {
  const kv = fakeKV();
  const p = await fresh();
  const env = { GROQ_KEYS: "", KEYS_KV: kv };
  const add = await p.addKeys(env, K2);
  const id = add.added[0].id;
  assert.deepEqual(await p.pool(env), [K2], "A1 加入后应可取到");

  assert.equal((await p.removeKey(env, id)).removed, true);
  assert.deepEqual(await p.pool(env), [], "A2 删除后应为空");

  const again = await p.addKeys(env, K2);
  assert.equal(again.added.length, 1);
  assert.deepEqual(await p.pool(env), [K2], "A3 删后重加必须能取到（旧实现返回 []）");

  // 缓存过期后重读 KV，仍应在（此时 KV 与覆盖层都已一致）
  assert.deepEqual(await p.pool(env, { fresh: true }), [K2], "A4 KV 追平后仍应在");
  assert.deepEqual((await p.poolDetail(env)).map((r) => r.key), [K2], "A5 管理台应能看到");
});

test("回归#3 KV 读失败时不能把整个动态池覆盖成只剩新 key", async () => {
  const store = new Map();
  let fail = false;
  const kv = {
    async get(k, type) {
      if (fail) throw new Error("KV read timeout"); // 模拟瞬态读失败
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  const p = await fresh();
  const env = { GROQ_KEYS: "", KEYS_KV: kv };

  await p.addKeys(env, K1);
  await p.addKeys(env, K2);
  assert.deepEqual((await p.pool(env)).sort(), [K1, K2].sort());

  fail = true;
  // 写路径拿不到基底时必须报错，不能默默用空基底覆盖
  await assert.rejects(() => p.addKeys(env, K3), /KV read timeout/);
  fail = false;
  assert.deepEqual((await p.pool(env, { fresh: true })).sort(), [K1, K2].sort(), "原有两把不能丢");

  // 读路径遇错要退回上一份缓存，而不是把动态 key 从号池里抹掉
  fail = true;
  assert.deepEqual((await p.pool(env, { fresh: true })).sort(), [K1, K2].sort(), "读失败应退回缓存");
});

test("回归#7 trim 后的 key 才是真正写出去的值", async () => {
  const store = new Map();
  const kv = {
    async get(k, type) { const v = store.get(k); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  const p = await fresh();
  const env = { GROQ_KEYS: `  ${K1}  `, KEYS_KV: kv }; // Secret 里带前后空白
  assert.deepEqual(await p.pool(env), [K1], "发出去的 key 不能带空白，否则上游 401");
});
