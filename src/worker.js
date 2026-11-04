/**
 * groq-proxy — Cloudflare Workers 号池版
 *
 * 相对原版（纯透传）的改动：
 *  1. 服务端持有 Groq key 池（Secret GROQ_KEYS，逗号分隔），客户端不再传 gsk_ key
 *  2. 对外只认一个代理令牌（Secret PROXY_TOKEN）
 *  3. 轮询起手 + 429/401/403 自动换下一个 key 重试
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

    // 简单探活 / 号池概览（不泄露 key）
    if (url.pathname === "/" || url.pathname === "/__pool") {
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

    // 请求体只读一次，用于多 key 重试
    const hasBody = !(request.method === "GET" || request.method === "HEAD");
    const body = hasBody ? await request.arrayBuffer() : undefined;

    const target = new URL(request.url);
    target.hostname = GROQ_HOST;

    const baseHeaders = new Headers(request.headers);
    baseHeaders.delete("host");
    baseHeaders.delete("authorization");
    baseHeaders.delete("cf-connecting-ip");
    baseHeaders.delete("cf-ipcountry");
    baseHeaders.delete("cf-ray");
    baseHeaders.delete("cf-visitor");
    baseHeaders.delete("x-forwarded-proto");
    baseHeaders.delete("x-real-ip");

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
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        lastResp = new Response(JSON.stringify({ error: { message: `upstream fetch failed: ${e.message}`, type: "upstream_error" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
        continue;
      }

      if (RETRY_STATUS.has(resp.status) && i < seq.length - 1) {
        // 该 key 被限流或失效，换下一个。响应体丢弃前先取消，避免占用额度
        coolKey(key, resp.status, resp.headers.get("retry-after"));
        try { await resp.body?.cancel(); } catch (_) {}
        lastResp = resp;
        continue;
      }

      const out = new Headers(resp.headers);
      out.set("x-groq-proxy-key", mask(key));
      out.set("x-groq-proxy-pool", `${keys.length}`);
      return cors(new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out }));
    }

    return cors(lastResp);
  },
};

