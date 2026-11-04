/**
 * admin.js 行为测试：登录、鉴权、增删接口、以及「页面内联脚本能通过语法解析」
 * 最后一条是回归测试——之前模板字符串把多行示例解释掉，线上脚本 SyntaxError，所有按钮全哑。
 */
import test from "node:test";
import assert from "node:assert/strict";

const TOKEN = "tok_admin_test_0123456789";
const K1 = "gsk_TESTAAAA111122223333";
const K2 = "gsk_TESTBBBB111122223333";

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

async function fresh() { return import(`../src/admin.js?t=${Math.random()}`); }
const env = () => ({ PROXY_TOKEN: TOKEN, GROQ_KEYS: K1, KEYS_KV: fakeKV() });
const basic = { authorization: `Basic ${btoa(`:${TOKEN}`)}` };

test("未登录 GET /admin → 200 登录页，页面不含令牌与 key", async () => {
  const a = await fresh();
  const res = await a.handleAdmin(new Request("https://gw.test/admin"), env());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("管理密码"));
  assert.equal(html.includes(TOKEN), false);
  assert.equal(html.includes(K1), false);
});

test("Basic 登录 GET /admin → 200 管理台，内联脚本可被解析", async () => {
  const a = await fresh();
  const res = await a.handleAdmin(new Request("https://gw.test/admin", { headers: basic }), env());
  assert.equal(res.status, 200);
  const html = await res.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, "页面应内联脚本");
  for (const s of scripts) {
    assert.doesNotThrow(() => new Function(s), "内联脚本必须能解析（上一版就是这里 SyntaxError）");
  }
  assert.equal(html.includes(TOKEN), false, "页面不得回显完整令牌");
  assert.equal(html.includes(K1), false, "页面不得包含完整 key");
});

test("密码错误 → 401；密码正确 → 302 + HttpOnly cookie", async () => {
  const a = await fresh();
  const bad = await a.handleAdmin(
    new Request("https://gw.test/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    }),
    env(),
  );
  assert.equal(bad.status, 401);

  const ok = await a.handleAdmin(
    new Request("https://gw.test/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(TOKEN)}`,
    }),
    env(),
  );
  assert.equal(ok.status, 302);
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /gp_session=[0-9a-f]{64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("未登录访问 API → 401", async () => {
  const a = await fresh();
  const res = await a.handleAdmin(new Request("https://gw.test/admin/api/state"), env());
  assert.equal(res.status, 401);
});

test("/admin/api/state → 只返回 mask 后的 key，含来源与 kv_enabled", async () => {
  const a = await fresh();
  const e = env();
  const res = await a.handleAdmin(new Request("https://gw.test/admin/api/state", { headers: basic }), e);
  const d = await res.json();
  assert.equal(d.pool_size, 1);
  assert.equal(d.kv_enabled, true);
  assert.equal(d.auth_required, true);
  assert.equal(d.keys[0].key, "gsk_...3333");
  assert.equal(d.keys[0].source, "secret");
  assert.equal(JSON.stringify(d).includes("AAAA1111"), false);
});

test("keys/add → 加入成功；再粘一次 → duplicate；脏数据 → invalid", async () => {
  const a = await fresh();
  const e = env();
  const post = (obj) =>
    new Request("https://gw.test/admin/api/keys/add", {
      method: "POST",
      headers: { ...basic, "content-type": "application/json" },
      body: JSON.stringify(obj),
    });

  const r1 = await (await a.handleAdmin(post({ keys: K2 }), e)).json();
  assert.equal(r1.added.length, 1);

  const r2 = await (await a.handleAdmin(post({ keys: K2 }), e)).json();
  assert.equal(r2.added.length, 0);
  assert.equal(r2.duplicate.length, 1);

  const r3 = await (await a.handleAdmin(post({ keys: "oops" }), e)).json();
  assert.equal(r3.invalid.length, 1);
});

test("keys/delete → 删掉 KV 来源；删除不存在的 id 返回 ok:false", async () => {
  const a = await fresh();
  const e = env();
  const add = await (await a.handleAdmin(
    new Request("https://gw.test/admin/api/keys/add", {
      method: "POST",
      headers: { ...basic, "content-type": "application/json" },
      body: JSON.stringify({ keys: K2 }),
    }),
    e,
  )).json();
  const id = add.added[0].id;

  const del = (body) =>
    new Request("https://gw.test/admin/api/keys/delete", {
      method: "POST",
      headers: { ...basic, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await (await a.handleAdmin(del({ id }), e)).json()).ok, true);
  assert.equal((await (await a.handleAdmin(del({ id }), e)).json()).ok, false);
});

test("未绑定 KEYS_KV 时 keys/add 返回 500 且带错误信息", async () => {
  const a = await fresh();
  const e = { PROXY_TOKEN: TOKEN, GROQ_KEYS: K1 };
  const res = await a.handleAdmin(
    new Request("https://gw.test/admin/api/keys/add", {
      method: "POST",
      headers: { ...basic, "content-type": "application/json" },
      body: JSON.stringify({ keys: K2 }),
    }),
    e,
  );
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /KEYS_KV/);
});

test("未知 /admin 路径 → 404 JSON", async () => {
  const a = await fresh();
  const res = await a.handleAdmin(new Request("https://gw.test/admin/api/nope", { headers: basic }), env());
  assert.equal(res.status, 404);
});

test("logout → 302 且清 cookie", async () => {
  const a = await fresh();
  const res = await a.handleAdmin(
    new Request("https://gw.test/admin/logout", { method: "POST", headers: basic }),
    env(),
  );
  assert.equal(res.status, 302);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});
