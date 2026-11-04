/**
 * groq-proxy — Cloudflare Workers 号池版
 *
 * 相对原版（纯透传）的改动：
 *  1. 服务端持有 Groq key 池（Secret GROQ_KEYS，逗号分隔），客户端不再传 gsk_ key
 *  2. 对外只认一个代理令牌（Secret PROXY_TOKEN）
 *  3. 随机起点轮询 + 仅 429/401 换下一个 key 重试（403 是按来源国判定的，换 key 无意义）
 *  4. 路径原样保留：/openai/v1/... → https://api.groq.com/openai/v1/...
 *     因此 base_url 仍是 https://<域名>/openai/v1（与 Deno 版一致，客户端无需改路径）
 *
 * 说明：
 *  - 请求体先读入内存再转发，目的是支持换 key 重试（body 流只能消费一次）。
 *    语音转写（multipart，≤25MB）在这个量级下没有压力。
 *  - 响应不做缓冲，SSE / 流式输出原样透传。
 *  - 不打印、不返回任何完整 key。
 */

import { handleAdmin } from "./admin.js";
import { pool, mask, safeEqual } from "./pool.js";

const GROQ_HOST = "api.groq.com";

// 只有「跟 key 绑定」的拒绝才值得换 key 重试：
//   429 = 该 key 限流，401 = 该 key 失效
// 403 不重试——Groq 的 403 是按客户端来源国（GeoIP）判定的，
// 换多少把 key 都一样，全池重试只会把上游请求放大 N 倍。
const RETRY_STATUS = new Set([429, 401]);

// 超过这个体积的请求体不读进内存（省内存，放弃换 key 重试）
const BUFFER_LIMIT = 8 * 1024 * 1024;

/**
 * 读请求体，最多 limit 字节。超过则返回 null（此时流已被读掉一部分，调用方必须放弃重试）。
 * 没有 content-length 的请求也走这里，所以读入量始终有硬上限。
 */
async function readUpTo(request, limit) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch (_) {}
        return null;
      }
      chunks.push(value);
    }
  } catch (_) {
    return null;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// isolate 级冷却表：刚被限流/失效的 key 排到最后，避免每个请求都先撞一遍
const cooldown = new Map();
const COOLDOWN_401 = 5 * 60_000;
const COOLDOWN_429 = 60_000;

function order(keys) {
  const now = Date.now();
  const hot = [];
  const cold = [];
  const start = Math.floor(Math.random() * keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(start + i) % keys.length];
    const until = cooldown.get(k) || 0;
    if (until > now) cold.push([k, until]);
    else hot.push(k);
  }
  // 全池都在冷却里时仍然要用，按最早恢复的先用
  if (!hot.length) return cold.sort((a, b) => a[1] - b[1]).map(([k]) => k);
  return [...hot, ...cold.sort((a, b) => a[1] - b[1]).map(([k]) => k)];
}

function coolKey(key, status, retryAfter) {
  const now = Date.now();
  let ms = status === 429 ? COOLDOWN_429 : COOLDOWN_401;
  const sec = Number(retryAfter);
  if (status === 429 && Number.isFinite(sec) && sec > 0) ms = Math.min(sec * 1000, 5 * 60_000);
  cooldown.set(key, now + ms);
  if (cooldown.size > 200) {
    for (const [k, until] of cooldown) if (until <= now) cooldown.delete(k);
  }
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "*");
  h.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // 管理页（自带 Basic 鉴权，走 /admin 前缀，与 API 转发路径不重叠）
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }

    // 极简健康位：无鉴权可探活，但不暴露任何号池信息
    if (url.pathname === "/healthz") {
      return cors(new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    }

    // 号池概览（mask 后的 key 尾 4 位）：属于运维信息，收进鉴权。
    // 设了 PROXY_TOKEN 就跟 API 一样要带 Bearer；未设令牌的部署保持公开。
    if (url.pathname === "/" || url.pathname === "/__pool") {
      if (env.PROXY_TOKEN) {
        const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
        if (!safeEqual(got, env.PROXY_TOKEN)) {
          return cors(new Response(JSON.stringify({ error: { message: "invalid proxy token", type: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }));
        }
      }
      const keys = await pool(env);
      return cors(
        new Response(
          JSON.stringify({
            service: "groq-proxy",
            mode: "pool",
            base_url: `https://${url.hostname}/openai/v1`,
            pool_size: keys.length,
            keys: keys.map(mask),
            auth_required: Boolean(env.PROXY_TOKEN),
          }, null, 2),
          { headers: { "content-type": "application/json; charset=utf-8" } },
        ),
      );
    }

    // 对外鉴权：设了 PROXY_TOKEN 就必须带 Authorization: Bearer <PROXY_TOKEN>
    if (env.PROXY_TOKEN) {
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!safeEqual(got, env.PROXY_TOKEN)) {
        return cors(new Response(JSON.stringify({ error: { message: "invalid proxy token", type: "unauthorized" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }));
      }
    }

    const keys = await pool(env);
    if (!keys.length) {
      return cors(new Response(JSON.stringify({ error: { message: "no groq keys configured", type: "server_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));
    }

    // 请求体只读一次，用于多 key 重试。大请求体不缓冲：读进内存既占 isolate
    // 内存，又要在重试时整份重发；这类请求用当前 key 流式转发且不重试。
    //
    // 关键词：**超限**才算大。没有 content-length 的请求（chunked / ReadableStream
    // 客户端）本身不说明大小，一律按大处理会让所有不带长度头的请求都失去重试能力，
    // 所以默认仍然缓冲；但要给缓冲设硬闸——边读边数，超过 BUFFER_LIMIT 立即放弃，
    // 退回原始流。这样既不会把 8MB 以上的体读进内存，也不会误伤小请求的重试。
    const hasBody = !(request.method === "GET" || request.method === "HEAD");
    const clRaw = request.headers.get("content-length");
    const declared = clRaw === null ? null : Number(clRaw);
    let bigBody = declared !== null && !(declared <= BUFFER_LIMIT);
    let body;
    if (hasBody && !bigBody) {
      const buf = await readUpTo(request, BUFFER_LIMIT);
      if (buf) {
        body = buf;
      } else {
        // 超限：原请求体已被消费，只能按「无体」转发并拒绝重试
        bigBody = true;
        body = null;
      }
    } else {
      body = hasBody ? request.body : null;
    }

    const target = new URL(request.url);
    target.hostname = GROQ_HOST;
    // 兼容把 base_url 写成 https://<域名>/v1 的客户端（OpenAI 习惯）：
    // Groq 的真实路径是 /openai/v1/*，不重写会直接 404 unknown_url。
    if (target.pathname.startsWith("/v1/")) target.pathname = `/openai${target.pathname}`;

    const baseHeaders = new Headers(request.headers);
    baseHeaders.delete("host");
    baseHeaders.delete("authorization");
    baseHeaders.delete("cf-connecting-ip");
    baseHeaders.delete("cf-ipcountry");
    baseHeaders.delete("cf-ray");
    baseHeaders.delete("cf-visitor");
    baseHeaders.delete("x-forwarded-proto");
    baseHeaders.delete("x-real-ip");
    baseHeaders.delete("cookie");

    // 随机起点 + 冷却表：多 isolate 间模块级游标不共享，固定起点会让各 isolate
    // 都偏向 keys[0]（实测 6 连发 4/2/0）；随机起点长期分布均匀（96 样本 30/28/31）。
    const seq = order(keys);
    let lastResp = null;

    for (let i = 0; i < seq.length; i++) {
      const key = seq[i];
      const headers = new Headers(baseHeaders);
      headers.set("authorization", `Bearer ${key}`);

      let resp;
      try {
        resp = await fetch(target.toString(), {
          method: request.method,
          headers,
          body,
          redirect: "follow",
          // 客户端断开就立刻中止上游，别再白烧额度；
          // 超时放宽到 300s——SSE 长输出可能超过 2 分钟，120s 会把它截断。
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
        });
      } catch (e) {
        lastResp = new Response(JSON.stringify({ error: { message: `upstream fetch failed: ${e.message}`, type: "upstream_error" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
        // 流式请求体（>8MB 或没有 content-length）已被上游消费掉，
        // 换 key 重发只会发一个空 body；直接返回错误，不要空转 N 次白记冷却。
        if (bigBody) break;
        continue;
      }

      if (RETRY_STATUS.has(resp.status)) {
        // 该 key 被限流或失效：无论是不是最后一发都记进冷却，下次不再优先撞它
        coolKey(key, resp.status, resp.headers.get("retry-after"));
        if (!bigBody && i < seq.length - 1) {
          // 响应体丢弃前先取消，避免占用额度
          try { await resp.body?.cancel(); } catch (_) {}
          lastResp = resp;
          continue;
        }
        // 流式请求体不能重发：保留这一发的结果，结束循环
        if (bigBody) {
          lastResp = resp;
          break;
        }
      }

      if (resp.status === 200 && cooldown.has(key)) cooldown.delete(key);
      const out = new Headers(resp.headers);
      out.set("x-groq-proxy-key", mask(key));
      out.set("x-groq-proxy-pool", `${keys.length}`);
      return cors(new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out }));
    }

    return cors(lastResp);
  },
};

