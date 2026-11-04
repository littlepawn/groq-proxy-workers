/**
 * groq-proxy admin v2 — 号池管理页（零依赖，纯 Workers）
 *
 * 路径：
 *   GET  /admin              登录页（未登录）或管理台（已登录）
 *   POST /admin/login        表单登录（只有密码一栏，密码 = env.PROXY_TOKEN）
 *   POST /admin/logout       退出（清 cookie）
 *   GET  /admin/api/state    号池状态（含每个 key 的来源与 id）
 *   POST /admin/api/test     逐 key 探活（并发，带限流头）
 *   POST /admin/api/keys/add    自助添加 key（写入 KV，格式 gsk_，逗号/换行分隔）
 *   POST /admin/api/keys/delete 自助删除 key（body: {id}，仅 KV 来源可删）
 *   GET  /admin/api/models   从 Groq 拉模型清单（含模态分组）
 *   POST /admin/api/chat     最小对话测试（body: {model, prompt}）
 *
 * 鉴权：
 *   - 浏览器：登录后发 HttpOnly cookie（值为 SHA-256(固定前缀 + PROXY_TOKEN)），7 天有效
 *   - curl/API：仍支持 Basic（用户名任意，密码 = PROXY_TOKEN）
 *
 * 说明：
 *  - 用量取自 Groq 响应头 x-ratelimit-*（实时），管理页不持久化任何数据
 *  - key 一律 mask（只露尾 4 位），页面源码与 API 响应不含完整 key / 完整令牌
 */

import { poolDetail, addKeys, removeKey, mask, safeEqual } from "./pool.js";

const GROQ = "https://api.groq.com";
const COOKIE = "gp_session";
const SESSION_SALT = "groq-proxy-admin-v2";

const enc = new TextEncoder();

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionValue(env) {
  return sha256Hex(`${SESSION_SALT}:${env.PROXY_TOKEN || ""}`);
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function checkBasic(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(auth.slice(6).trim());
  } catch (_) {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return safeEqual(decoded.slice(idx + 1), env.PROXY_TOKEN);
}

async function isAuthed(request, env) {
  if (!env.PROXY_TOKEN) return false;
  if (checkBasic(request, env)) return true;
  const c = getCookie(request, COOKIE);
  if (!c) return false;
  const expect = await sessionValue(env);
  if (c.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < c.length; i++) diff |= c.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

/* ---------------- Groq 探测 ---------------- */

/**
 * 逐个 key 打一次最小 chat 请求，拿状态码 + 限流头（/models 不返回 x-ratelimit-*）。
 * 并发上限 PROBE_CONCURRENCY：号池变大后全池同时打会把子请求数一次顶到
 * Workers 单请求 50 的上限，且瞬时挤占同一账号的 RPM。
 */
const PROBE_CONCURRENCY = 6;

/** 随机起点遍历池：管理台的 models/chat 测试不该每次都固定撞第一把 key */
function rotate(keys) {
  if (!keys.length) return keys;
  const start = Math.floor(Math.random() * keys.length);
  return keys.slice(start).concat(keys.slice(0, start));
}

async function probe(keys) {
  const out = new Array(keys.length);
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const i = next++;
      out[i] = await probeOne(keys[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, keys.length) }, worker));
  return out;
}

async function probeOne(k, i) {
  const t0 = Date.now();
  const rec = { index: i, key: mask(k), status: null, ms: null, error: null, limits: {} };
  try {
    const r = await fetch(`${GROQ}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      // 单把 key 卡住不能拖垮整页探活
      signal: AbortSignal.timeout(30_000),
    });
    rec.status = r.status;
    rec.ms = Date.now() - t0;
    for (const [h, v] of r.headers) {
      const hl = h.toLowerCase();
      if (hl.startsWith("x-ratelimit-") || hl === "retry-after") rec.limits[hl] = v;
    }
    if (r.status !== 200) {
      const body = await r.text();
      try {
        rec.error = JSON.parse(body)?.error?.message || body.slice(0, 160);
      } catch (_) {
        rec.error = body.slice(0, 160);
      }
    } else {
      await r.body?.cancel();
    }
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.error = e.message;
  }
  return rec;
}

function modalityTags(m) {
  const out = m.output_modalities || [];
  const inp = m.input_modalities || [];
  if (out.includes("transcription")) return ["音频转写"];
  if (out.includes("speech")) return ["语音合成"];
  if (inp.includes("image") && out.includes("text")) return ["聊天", "视觉"];
  if (inp.includes("text") && out.includes("text")) {
    if ((m.id || "").includes("guard") || (m.id || "").includes("safeguard")) return ["内容安全"];
    return ["聊天"];
  }
  return ["其他"];
}

async function fetchModels(key) {
  const r = await fetch(`${GROQ}/openai/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return { error: `upstream ${r.status}`, status: r.status };
  const d = await r.json();
  const models = (d.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    owned_by: m.owned_by || "",
    context: m.context_window ?? null,
    tags: modalityTags(m),
    features: m.supported_features || [],
  }));
  return { models };
}

/* ---------------- 页面 ---------------- */

function escHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

function curlSample(baseUrl) {
  return [
    `curl "${baseUrl}/chat/completions" ${BS}`,
    `  -H "Authorization: Bearer $PROXY_TOKEN" ${BS}`,
    `  -H "Content-Type: application/json" ${BS}`,
    `  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"hi"}]}'`,
  ].join(NL);
}

function pySample(baseUrl) {
  return [
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    `    base_url="${baseUrl}",`,
    '    api_key="$PROXY_TOKEN",  # 即管理页登录密码',
    ")",
    "r = client.chat.completions.create(",
    '    model="openai/gpt-oss-20b",',
    '    messages=[{"role": "user", "content": "hi"}],',
    ")",
    "print(r.choices[0].message.content)",
  ].join(NL);
}

function loginPage(msg) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Groq 号池 · 登录</title>
<style>
  :root{--bg:#0b0e14;--card:#151a23;--line:#2a3140;--fg:#e8edf4;--dim:#8b95a7;--accent:#5b9dff}
  @media(prefers-color-scheme:light){:root{--bg:#f2f4f8;--card:#fff;--line:#d9dee7;--fg:#1c2230;--dim:#69748a;--accent:#2563eb}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
  .box{width:360px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px;
       box-shadow:0 12px 40px rgba(0,0,0,.25)}
  .logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#f55036,#c2370c);
       display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:20px;margin:0 auto 14px}
  h1{font-size:17px;text-align:center;margin:0 0 4px}
  .sub{color:var(--dim);font-size:12px;text-align:center;margin-bottom:22px}
  input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);
        font-size:14px;outline:none}
  input:focus{border-color:var(--accent)}
  button{width:100%;margin-top:12px;padding:10px;border-radius:8px;border:0;background:var(--accent);color:#fff;
         font-size:14px;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .err{color:#f85149;font-size:12px;text-align:center;min-height:16px;margin-top:10px}
</style></head><body><form class="box" method="post" action="/admin/login">
  <div class="logo">G</div>
  <h1>Groq 号池管理</h1>
  <div class="sub">groq-proxy · Cloudflare Workers</div>
  <input type="password" name="password" placeholder="管理密码" autofocus autocomplete="current-password" required>
  <button type="submit">进入管理台</button>
  <div class="err">${msg || ""}</div>
</form></body></html>`;
}

function dashboard(baseUrl, tokenHint) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Groq 号池管理</title>
<style>
  :root{--bg:#0b0e14;--card:#151a23;--line:#2a3140;--fg:#e8edf4;--dim:#8b95a7;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;
        --accent:#5b9dff;--track:#1d2330}
  @media(prefers-color-scheme:light){:root{--bg:#f2f4f8;--card:#fff;--line:#d9dee7;--fg:#1c2230;--dim:#69748a;
        --ok:#059669;--warn:#b45309;--bad:#dc2626;--accent:#2563eb;--track:#e8ecf2}}
  *{box-sizing:border-box}
  body{margin:0;padding:0 20px 40px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       background:var(--bg);color:var(--fg)}
  .wrap{max-width:1120px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;padding:18px 0 6px;flex-wrap:wrap;gap:10px}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#f55036,#c2370c);
        display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:18px}
  h1{font-size:17px;margin:0}
  .sub{color:var(--dim);font-size:12px}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 14px;
         font-size:13px;cursor:pointer;transition:.15s}
  button:hover{border-color:var(--accent);color:var(--accent)}
  button:disabled{opacity:.5;cursor:default}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover{color:#fff;filter:brightness(1.08)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .stat .v{font-size:22px;font-weight:700;margin-top:2px}
  .stat .l{color:var(--dim);font-size:12px}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  section h2{font-size:14px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  section h2 .hint{font-weight:400;color:var(--dim);font-size:12px;margin-left:auto}
  .kg{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
  .kcard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--track)}
  .kcard .top{display:flex;justify-content:space-between;align-items:center}
  .kcard code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .pill{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11.5px;border:1px solid}
  .ok{color:var(--ok);border-color:var(--ok)} .warn{color:var(--warn);border-color:var(--warn)} .bad{color:var(--bad);border-color:var(--bad)}
  .pbar{height:6px;border-radius:3px;background:var(--line);margin-top:10px;overflow:hidden}
  .pbar>i{display:block;height:100%;border-radius:3px;background:var(--ok);transition:width .4s}
  .pbar>i.mid{background:var(--warn)} .pbar>i.low{background:var(--bad)}
  .plabel{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim);margin-top:4px}
  .errline{color:var(--bad);font-size:12px;margin-top:8px}
  .tag{display:inline-block;padding:0 8px;margin:2px 4px 2px 0;border-radius:8px;font-size:11px;
       background:var(--track);border:1px solid var(--line);color:var(--dim)}
  .tag.hot{color:var(--accent);border-color:var(--accent)}
  .mt{display:flex;flex-wrap:wrap;gap:8px}
  .mitem{border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--track);cursor:pointer;transition:.15s}
  .mitem:hover{border-color:var(--accent)}
  .mitem .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .mitem .meta{color:var(--dim);font-size:11px;margin-top:2px}
  .copy{background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;padding:0}
  code.inline{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--track);
       padding:2px 8px;border-radius:6px;word-break:break-all}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  select,input[type=text]{padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:13px;outline:none}
  select:focus,input:focus{border-color:var(--accent)}
  #chatOut{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
       background:var(--track);border:1px solid var(--line);border-radius:10px;padding:12px;min-height:60px;max-height:280px;overflow:auto}
  .muted{color:var(--dim)} .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dim);
       border-top-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--accent);color:#fff;
       padding:8px 18px;border-radius:20px;font-size:13px;opacity:0;transition:.3s;pointer-events:none;z-index:9}
  .toast.show{opacity:1}
  details{color:var(--dim);font-size:12.5px} details summary{cursor:pointer;color:var(--fg)}
  details code{word-break:break-all}
</style></head><body><div class="wrap">
<header>
  <div class="brand"><div class="logo">G</div><div><h1>Groq 号池管理</h1><div class="sub">groq-proxy · Cloudflare Workers · <span id="colo">—</span></div></div></div>
  <div class="actions">
    <button id="btn-refresh">刷新</button>
    <button id="btn-test" class="primary">探活全部 Key</button>
    <button id="btn-logout">退出</button>
  </div>
</header>

<div class="grid">
  <div class="stat"><div class="l">号池规模</div><div class="v" id="st-pool">—</div></div>
  <div class="stat"><div class="l">健康 Key</div><div class="v" id="st-ok">—</div></div>
  <div class="stat"><div class="l">剩余请求额度</div><div class="v" id="st-req">—</div></div>
  <div class="stat"><div class="l">可用模型</div><div class="v" id="st-models">—</div></div>
  <div class="stat"><div class="l">平均延迟</div><div class="v" id="st-ms">—</div></div>
</div>

<section>
  <h2>Key 状态 <span class="hint">额度实时取自 Groq 限流响应头</span></h2>
  <div class="kg" id="keys"><div class="muted">点「探活全部 Key」开始</div></div>
  <details style="margin-top:12px"><summary>为什么探活全部 403？</summary>
    <p>Groq 按<b>客户端来源国</b>判定访问：中国大陆直连本站时，Worker 子请求会被打上 CN 标签，被 Groq 拒绝（403 Forbidden）。
    这不是 key 失效——经境外网络访问即恢复 200。要国内直连可用，需要自建固定境外出口。</p>
  </details>
</section>

<section>
  <h2>Key 管理 <span class="hint">添加即时生效（KV 存储，无需重新部署）</span></h2>
  <div class="row">
    <textarea id="add-keys" rows="3" placeholder="粘贴新 key，每行一把或用逗号分隔（gsk_ 开头）" style="flex:1;min-width:260px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:12.5px;font-family:ui-monospace,Menlo,monospace"></textarea>
    <button id="btn-add" class="primary">添加</button>
  </div>
  <div class="row"><span id="add-msg" class="muted"></span></div>
  <details><summary>说明</summary>
    <p>来源为 <code class="inline">Secret</code> 的 key 来自部署时的 GROQ_KEYS 环境变量（页面只读，删不掉）；
    来源为 <code class="inline">管理台</code> 的 key 存在 Cloudflare KV，可随时增删，改动最迟 30 秒内全量生效。</p>
  </details>
</section>

<section>
  <h2>模型清单 <span class="hint">点击复制模型 ID · 数据来自 /models</span></h2>
  <div class="row">
    <button id="btn-models">加载模型</button>
    <span id="models-msg" class="muted"></span>
  </div>
  <div class="mt" id="models"><span class="muted">未加载</span></div>
</section>

<section>
  <h2>对话测试 <span class="hint">走当前号池轮询，消耗额度极少</span></h2>
  <div class="row">
    <select id="chat-model"></select>
    <input type="text" id="chat-prompt" placeholder="输入测试内容，如：你好" style="flex:1;min-width:200px">
    <button id="btn-chat" class="primary">发送</button>
  </div>
  <div id="chatOut"><span class="muted">尚未测试</span></div>
</section>

<section>
  <h2>接入配置 <span class="hint">登录密码即 API 令牌完整值</span></h2>
  <div class="row"><span class="muted" style="width:70px">base_url</span><code class="inline" id="cfg-base">${escHtml(baseUrl)}</code><button class="copy" id="cp-base">复制</button></div>
  <div class="row"><span class="muted" style="width:70px">令牌</span><code class="inline">${escHtml(tokenHint)}</code></div>
  <details><summary>curl 示例</summary><pre style="white-space:pre-wrap;margin:8px 0 0"><code>${escHtml(curlSample(baseUrl))}</code></pre></details>
  <details><summary>OpenAI SDK（Python）示例</summary><pre style="white-space:pre-wrap;margin:8px 0 0"><code>${escHtml(pySample(baseUrl))}</code></pre></details>
</section>
</div>
<div class="toast" id="toast"></div>
<script>
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let BASE="";

function toast(t){const el=$("toast");el.textContent=t;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),1600);}
function copyText(t){navigator.clipboard.writeText(t).then(()=>toast("已复制")).catch(()=>toast("复制失败"));}
function pill(s){const cls=s===200?"ok":(s===429?"warn":"bad");return '<span class="pill '+cls+'">'+esc(s??"ERR")+"</span>";}

async function loadState(){
  try{
    const r=await fetch("/admin/api/state");
    if(!r.ok)throw new Error("HTTP "+r.status);
    const d=await r.json();
    BASE=d.base_url;
    $("st-pool").textContent=d.pool_size;
    $("colo").textContent=d.colo?("出口 "+d.colo):"";
    BASE=d.base_url;
    $("cfg-base").textContent=d.base_url;
  }catch(e){toast("状态加载失败: "+e.message);}
}

async function testAll(){
  const btn=$("btn-test");btn.disabled=true;
  $("st-ok").textContent="…";
  try{
    const r=await fetch("/admin/api/test",{method:"POST"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    const d=await r.json();
    const box=$("keys");box.innerHTML="";
    let ok=0,remSum=0,msSum=0,msN=0;
    for(const x of d.results){
      const rem=parseInt(x.limits["x-ratelimit-remaining-requests"]??"NaN");
      const lim=parseInt(x.limits["x-ratelimit-limit-requests"]??"NaN");
      const tokRem=x.limits["x-ratelimit-remaining-tokens"];
      const reset=x.limits["x-ratelimit-reset-requests"]??"";
      let pct=lim>0&&rem>=0?Math.round(rem/lim*100):null;
      const cls=pct==null?"":(pct>50?"":(pct>20?"mid":"low"));
      if(x.status===200)ok++;
      if(rem>=0)remSum+=rem;
      if(x.ms!=null){msSum+=x.ms;msN++;}
      const card=document.createElement("div");card.className="kcard";
      const delBtn=(x.source==="kv"&&x.id)
        ?'<button class="copy" data-del="'+esc(x.id)+'" style="color:var(--bad)">删除</button>':"";
      const srcTag=x.source?('<span class="tag">'+(x.source==="kv"?"管理台":"Secret")+"</span>"):"";
      card.innerHTML=
        '<div class="top"><span><code>'+esc(x.key)+"</code> "+srcTag+"</span>"+'<span style="display:flex;gap:8px;align-items:center">'+pill(x.status)+delBtn+"</span></div>"+
        (pct!=null
          ?'<div class="pbar"><i class="'+cls+'" style="width:'+pct+'%"></i></div>'+
           '<div class="plabel"><span>剩余请求 '+esc(rem)+'/'+esc(lim)+'</span><span>'+pct+'%</span></div>'
          :'<div class="plabel"><span>剩余请求 —</span></div>')+
        '<div class="plabel"><span>Token 剩余 '+esc(tokRem??"—")+'</span><span>'+
          (x.ms!=null?x.ms+" ms":"—")+(reset?" · reset "+esc(reset):"")+'</span></div>'+
        (x.error?'<div class="errline">'+esc(x.error)+"</div>":"");
      box.appendChild(card);
      const db=card.querySelector("[data-del]");
      if(db)db.onclick=()=>delKey(db.getAttribute("data-del"),x.key);
    }
    $("st-pool").textContent=d.results.length;
    $("st-ok").textContent=d.results.length?ok+"/"+d.results.length:"0";
    $("st-req").textContent=remSum||"—";
    $("st-ms").textContent=msN?(msSum/msN).toFixed(0)+" ms":"—";
    if(d.results.length&&!ok)toast("全部 403：当前来源被 Groq 拒绝");
  }catch(e){toast("探活失败: "+e.message);$("st-ok").textContent="—";}
  finally{btn.disabled=false;}
}

async function delKey(id,keyLabel){
  if(!confirm("确定从号池移除 "+keyLabel+" ？"))return;
  try{
    const r=await fetch("/admin/api/keys/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id})});
    const d=await r.json();
    if(d.ok){toast("已移除 "+keyLabel);testAll();}
    else toast("移除失败: "+(d.error||"未知"));
  }catch(e){toast("移除失败: "+e.message);}
}

async function submitAdd(){
  const btn=$("btn-add");btn.disabled=true;
  const ta=$("add-keys");
  const raw=ta.value.trim();
  const msg=$("add-msg");
  if(!raw){msg.textContent="请先粘贴 key";btn.disabled=false;return;}
  msg.innerHTML='<span class="spin"></span>添加中…';
  try{
    const r=await fetch("/admin/api/keys/add",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({keys:raw})});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||"HTTP "+r.status);
    const parts=[];
    if(d.added.length)parts.push("已添加 "+d.added.map(x=>x.key).join("、"));
    if(d.duplicate.length)parts.push("重复跳过 "+d.duplicate.join("、"));
    if(d.invalid.length)parts.push("格式无效 "+d.invalid.join("、"));
    msg.textContent=parts.join(" · ")||"没有变化";
    ta.value="";
    toast("号池更新完成");
    testAll();
  }catch(e){msg.textContent="添加失败: "+e.message;}
  finally{btn.disabled=false;}
}

async function loadModels(){
  $("models-msg").innerHTML='<span class="spin"></span>加载中…';
  try{
    const r=await fetch("/admin/api/models");
    if(!r.ok)throw new Error("HTTP "+r.status);
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    const box=$("models");box.innerHTML="";
    $("st-models").textContent=d.models.length;
    const sel=$("chat-model");sel.innerHTML="";
    for(const m of d.models){
      const it=document.createElement("div");it.className="mitem";
      it.innerHTML='<div class="id">'+esc(m.id)+'</div><div class="meta">'+esc(m.tags.join(" · "))+
        (m.context?" · "+esc(m.context)+" ctx":"")+"</div>";
      it.onclick=()=>copyText(m.id);
      box.appendChild(it);
      if(m.tags.includes("聊天")){const o=document.createElement("option");o.value=m.id;o.textContent=m.id;sel.appendChild(o);}
    }
    $("models-msg").textContent="共 "+d.models.length+" 个 · 更新于 "+new Date().toLocaleTimeString();
  }catch(e){$("models-msg").textContent="加载失败: "+e.message;}
}

async function sendChat(){
  const btn=$("btn-chat");btn.disabled=true;
  $("chatOut").innerHTML='<span class="spin"></span>请求中…';
  try{
    const r=await fetch("/admin/api/chat",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:$("chat-model").value||"openai/gpt-oss-20b",prompt:$("chat-prompt").value||"hi"})});
    const d=await r.json();
    $("chatOut").textContent=d.ok
      ?("["+d.key+" · "+d.ms+" ms]\\n"+d.content)
      :("失败 "+r.status+": "+(d.error||"未知错误"));
  }catch(e){$("chatOut").textContent="请求失败: "+e.message;}
  finally{btn.disabled=false;}
}

$("btn-refresh").onclick=loadState;
$("btn-test").onclick=testAll;
$("btn-add").onclick=submitAdd;
$("btn-models").onclick=loadModels;
$("btn-chat").onclick=sendChat;
$("chat-prompt").addEventListener("keydown",(e)=>{if(e.key==="Enter")sendChat();});
$("cp-base").onclick=()=>copyText(BASE);
$("btn-logout").onclick=async()=>{await fetch("/admin/logout",{method:"POST"});location.reload();};
loadState();
</script></body></html>`;
}

/* ---------------- 路由 ---------------- */

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  // 登录（无需已登录）
  if (url.pathname === "/admin/login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const pass = form?.get("password") || "";
    if (safeEqual(pass, env.PROXY_TOKEN)) {
      const v = await sessionValue(env);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/admin",
          "set-cookie": `${COOKIE}=${v}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
        },
      });
    }
    return new Response(loginPage("密码错误"), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return new Response(null, {
      status: 302,
      headers: {
        location: "/admin",
        "set-cookie": `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  const authed = await isAuthed(request, env);

  if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin/login") {
    // 未登录访问 /admin/login 也回登录页（GET 直敲地址不该 401）；已登录同样进管理台
    if (!authed) return new Response(loginPage(""), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
    const t = env.PROXY_TOKEN || "";
    const hint = t ? `已设置（${t.length} 字符，登录密码即此令牌完整值）` : "（未设置 PROXY_TOKEN）";
    const baseUrl = `https://${url.hostname}/openai/v1`;
    return new Response(dashboard(baseUrl, hint), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!authed) return json({ error: "unauthorized" }, 401);

  const detail = await poolDetail(env);
  const keys = detail.map((d) => d.key);

  if (url.pathname === "/admin/api/state") {
    return json({
      service: "groq-proxy",
      base_url: `https://${url.hostname}/openai/v1`,
      pool_size: keys.length,
      keys: detail.map((d) => ({ key: mask(d.key), source: d.source, id: d.id, added: d.added })),
      kv_enabled: Boolean(env.KEYS_KV),
      auth_required: Boolean(env.PROXY_TOKEN),
      colo: request.cf?.colo || null,
    });
  }

  // 探活结果附带来源与 id（供前端渲染删除按钮）
  if (url.pathname === "/admin/api/test" && request.method === "POST") {
    const meta = new Map(detail.map((d) => [mask(d.key), { id: d.id, source: d.source }]));
    const results = (await probe(keys)).map((r) => ({ ...r, ...(meta.get(r.key) || {}) }));
    return json({ results, colo: request.cf?.colo || null });
  }

  // 自助增删 key（写入 KV；Secret 里的静态 key 不可删）
  if (url.pathname === "/admin/api/keys/add" && request.method === "POST") {
    const bodyIn = await request.json().catch(() => ({}));
    try {
      const r = await addKeys(env, String(bodyIn.keys || ""));
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  if (url.pathname === "/admin/api/keys/delete" && request.method === "POST") {
    const bodyIn = await request.json().catch(() => ({}));
    const id = String(bodyIn.id || "");
    try {
      const r = await removeKey(env, id);
      return json({ ok: r.removed });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  if (url.pathname === "/admin/api/models") {
    if (!keys.length) return json({ error: "pool empty" }, 500);
    // 不再固定 keys[0]：按池序遍历，第一个成功即返回（避免某把 key 失效导致永远拉不到）
    let last = null;
    for (const k of rotate(keys)) {
      const d = await fetchModels(k);
      if (!d.error) return json(d);
      last = d;
      if (d.status !== 429 && d.status !== 401) break;
    }
    return json(last || { error: "no key available" }, 502);
  }

  if (url.pathname === "/admin/api/chat" && request.method === "POST") {
    const bodyIn = await request.json().catch(() => ({}));
    const model = String(bodyIn.model || "openai/gpt-oss-20b");
    const prompt = String(bodyIn.prompt || "hi").slice(0, 2000);
    const t0 = Date.now();
    // 走池：随机起点挑一把（不再固定 keys[0]），便于验证当前会被选中的 key 是否可用
    const usedKey = rotate(keys)[0] || "";
    try {
      const r = await fetch(`${GROQ}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${usedKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 512,
          reasoning_effort: "low",
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const ms = Date.now() - t0;
      const d = await r.json().catch(() => ({}));
      if (r.status !== 200) {
        return json({ ok: false, status: r.status, error: d?.error?.message || "upstream error" }, r.status);
      }
      const msg0 = d.choices?.[0]?.message || {};
      return json({
        ok: true,
        ms,
        key: mask(usedKey),
        content: msg0.content || msg0.reasoning || JSON.stringify(d).slice(0, 500),
      });
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}
