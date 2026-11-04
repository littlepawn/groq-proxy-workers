/**
 * worker.js 行为测试：用 stub fetch 替换上游，不消耗任何真实 Groq 额度
 * 运行：node --test /tmp/gptest/worker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const KEYS = ["gsk_TESTAAAA111122223333", "gsk_TESTBBBB111122223333", "gsk_TESTCCCC111122223333"];
process.env.TOKEN = "tok_test";

// 每轮测试前重新 import，拿到干净的模块级状态（cooldown）
async function freshWorker(calls) {
  globalThis.__plan = null;
  globalThis.fetch = async (url, init) => {
    const auth = (init?.headers?.get ? init.headers.get("authorization") : init?.headers?.authorization) || "";
    const key = auth.replace(/^Bearer\s+/i, "");
    calls.push({ url: String(url), key, init });
    const plan = globalThis.__plan?.(key, calls.length) || { status: 200 };
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    return new Response(JSON.stringify({ ok: true }), {
      status: plan.status || 200,
      headers: plan.headers || { "content-type": "application/json" },
    });
  };
  const mod = await  import(`../src/worker.js?t=${Math.random()}`);
  return mod.default;
}

function req(path = "/openai/v1/chat/completions", opts = {}) {
  return new Request(`https://gw.test${path}`, {
    method: opts.method || "POST",
    headers: {
      authorization: opts.token === undefined ? `Bearer ${process.env.TOKEN}` : opts.token,
      "content-type": "application/json",
      "cf-connecting-ip": "1.2.3.4",
      ...(opts.headers || {}),
    },
    body: opts.method === "GET" ? undefined : JSON.stringify({ model: "m", messages: [] }),
  });
}

const env = () => ({ GROQ_KEYS: KEYS.join(","), PROXY_TOKEN: process.env.TOKEN });

test("无令牌 → 401 且不打上游", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(req("/openai/v1/models", { token: null, method: "GET" }), env());
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("令牌正确 → 200，Authorization 换成 gsk_ key，客户端 IP 头被剥离", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(req(), env());
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].key, /^gsk_/);
  assert.equal(calls[0].init.headers.get("cf-connecting-ip"), null);
  assert.equal(res.headers.get("x-groq-proxy-pool"), "3");
});

test("401 的 key 会换下一把重试，且进冷却", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  // 第一把 key 一律 401，其余 200
  let bad = null;
  globalThis.__plan = (key, n) => {
    if (n === 1) { bad = key; return { status: 401 }; }
    return { status: 200 };
  };
  const res = await w.fetch(req(), env());
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].key, bad);
  const served = res.headers.get("x-groq-proxy-key");
  assert.ok(served.startsWith("gsk_..."));
  assert.equal(served.slice(-4), calls[1].key.slice(-4));
});

test("403 不重试：只打一次上游（GeoIP 类拒绝与 key 无关）", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  globalThis.__plan = () => ({ status: 403 });
  const res = await w.fetch(req(), env());
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1);
  // 403 走正常返回路径（不重试），因此仍带命中头——这是期望行为
  assert.equal(res.headers.get("x-groq-proxy-pool"), "3");
});

test("429 带 retry-after 会冷却：后续请求优先用别的 key", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  let limited = null;
  globalThis.__plan = (key, n) => {
    if (n === 1) { limited = key; return { status: 429, headers: { "retry-after": "120" } }; }
    return { status: 200 };
  };
  const r1 = await w.fetch(req(), env());
  assert.equal(r1.status, 200);
  assert.equal(calls.length, 2);
  // 再来 6 次，冷却中的 key 应始终排在最后（尽量不命中）
  let hits = 0;
  for (let i = 0; i < 6; i++) {
    const before = calls.length;
    await w.fetch(req(), env());
    if (calls[before].key === limited) hits++;
  }
  assert.equal(hits, 0, `冷却期内不该把限流 key 排在首位（实际命中 ${hits} 次）`);
});

test("大请求体（>8MB）不重试：即使 429 也只打一次上游", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  globalThis.__plan = () => ({ status: 429, headers: { "retry-after": "60" } });
  const big = new Uint8Array(9 * 1024 * 1024);
  const r = new Request("https://gw.test/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-length": String(big.length) },
    body: big,
  });
  const res = await w.fetch(r, env());
  assert.equal(res.status, 429);
  assert.equal(calls.length, 1);
});

test("OPTIONS 预检 → 204 且不打上游", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(new Request("https://gw.test/openai/v1/x", { method: "OPTIONS" }), env());
  assert.equal(res.status, 204);
  assert.equal(calls.length, 0);
});

test("/healthz 无需令牌 → 200 且不含号池信息", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(new Request("https://gw.test/healthz", { method: "GET" }), env());
  assert.equal(res.status, 200);
  const txt = await res.text();
  assert.equal(txt.includes("gsk_"), false);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("/__pool 无令牌 → 401；带令牌 → 200 且只露尾 4 位", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const noTok = await w.fetch(new Request("https://gw.test/__pool", { method: "GET" }), env());
  assert.equal(noTok.status, 401);

  const ok = await w.fetch(new Request("https://gw.test/__pool", {
    method: "GET",
    headers: { authorization: `Bearer ${process.env.TOKEN}` },
  }), env());
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.pool_size, 3);
  assert.deepEqual(body.keys, ["gsk_...3333", "gsk_...3333", "gsk_...3333"]);
  assert.equal(JSON.stringify(body).includes("AAAA111122223333"), false);
});

test("未配置 PROXY_TOKEN 时不鉴权（保持可自测）", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(req("/openai/v1/models", { token: null, method: "GET" }), { GROQ_KEYS: KEYS.join(",") });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("号池为空 → 500 且不打上游", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  const res = await w.fetch(req(), { GROQ_KEYS: "", PROXY_TOKEN: process.env.TOKEN });
  assert.equal(res.status, 500);
  assert.equal(calls.length, 0);
});

// ── 回归：请求体缓冲必须有硬上限（2026-11-05 审查高危 #1）───────────────
test("回归#1 声明超限 → 直接走流式，不读进内存", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  globalThis.__plan = () => ({ status: 200 });
  const big = new Uint8Array(9 * 1024 * 1024);
  const r = new Request("https://gw.test/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-length": String(big.length) },
    body: big,
  });
  await w.fetch(r, env());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.body instanceof ReadableStream, "声明超限应转发原始流");
});

test("回归#1 未声明长度但实际超限 → 缓冲被硬闸拦住，最多读 BUFFER+1 字节", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  globalThis.__plan = () => ({ status: 200 });

  let produced = 0;
  let done = false;
  const chunk = new Uint8Array(256 * 1024);
  const stream = new ReadableStream({
    pull(ctrl) {
      // ctrl.close() 之后 pull 仍可能被调用一次，用 done 位了结，避免误判
    if (done) return;
    if (produced > 40 * 1024 * 1024) { done = true; ctrl.close(); return; }
      produced += chunk.length;
      ctrl.enqueue(chunk);
    },
  });
  const r = new Request("https://gw.test/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TOKEN}` },
    body: stream,
    duplex: "half",
  });
  assert.equal(r.headers.get("content-length"), null, "前提：确实没有 content-length");

  await w.fetch(r, env());
  // 断言读取量的**上界**：40MB 的流必须在 8MB 附近就停。
  // 下界不能断言——fetch 会把原始流再读一遍（取消后读到 EOF 即返回），
  // 这里的 produced 反映的是「源总共被拉了多少」，上界才是硬闸的真实证据。
  assert.ok(produced <= 8 * 1024 * 1024 + 512 * 1024, `实际读了 ${produced} 字节，硬闸没生效`);
});

test("回归#1 无长度头的正常小请求仍保留重试能力", async () => {
  const calls = [];
  const w = await freshWorker(calls);
  globalThis.__plan = (key, n) => (n === 1 ? { status: 401 } : { status: 200 });
  const r = new Request("https://gw.test/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(r.headers.get("content-length"), null);
  const res = await w.fetch(r, env());
  assert.equal(res.status, 200, "小请求不受硬闸影响，遇到 401 仍应换 key");
  assert.equal(calls.length, 2);
});
