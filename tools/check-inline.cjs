#!/usr/bin/env node
/**
 * 抓管理台 HTML 里所有内联 <script> 单独编译一遍。
 *
 * 存在的理由：dashboard() 用模板字面量生成整页 HTML，只要模板里多出一个反引号
 * （哪怕写在注释里）就会提前闭合模板字符串，线上脚本被截断、所有按钮静默失效，
 * 而 `node --check src/admin.js` 依然通过。这个检查在开浏览器之前就能抓到那类截断。
 *
 * 校验两件事：
 *  1. 契约：dashboard() 源码里最后一个闭合标记必须真的结束整页（含 </html>）
 *  2. 产物：渲染出来的 HTML 里每段内联脚本都能被 new Function 编译
 */
const fs = require("node:fs");
const path = require("node:path");

const CLOSE = "</script></body></html>`;";

function extractDashboard(src) {
  const start = src.indexOf("function dashboard(");
  if (start < 0) throw new Error("admin.js 里找不到 dashboard()");
  const end = src.indexOf(CLOSE, start);
  if (end < 0) throw new Error("dashboard() 模板没有正常闭合（找不到 " + CLOSE + "）");
  // CLOSE 后紧跟的第一个 "\n}" 是函数自身的闭括号，必须一起带上
  const after = src.slice(end + CLOSE.length, end + CLOSE.length + 8);
  const brace = after.startsWith("\n}") ? 2 : 0;
  return src.slice(start, end + CLOSE.length + brace);
}

function render(seg) {
  const escHtml = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  // dashboard 引用了模块级的 curlSample/pySample/NL/BS，函数环境里补上桩实现
  const stubs = {
    escHtml,
    NL: "\n",
    BS: "\\",
    curlSample: (b) => `curl "${b}"`,
    pySample: (b) => `base_url="${b}"`,
  };
  const args = Object.keys(stubs);
  const vals = args.map((k) => `const ${k} = __stubs[${JSON.stringify(k)}];`).join("\n");
  const body = vals + "\n" + seg + '\nreturn dashboard("https://example.test/openai/v1", "hint");';
  const fn = new Function("__stubs", body);
  return fn(stubs);
}

const file = path.join(__dirname, "..", "src", "admin.js");
const seg = extractDashboard(fs.readFileSync(file, "utf8"));

let html;
try {
  html = render(seg);
} catch (e) {
  const ticks = (seg.match(/`/g) || []).length;
  throw new Error(
    `dashboard() 模板无法编译（${e.message}）。段内反引号 ${ticks} 个；` +
      `检查模板内部是否有未转义的反引号，尤其注释里。`,
  );
}

if (!html.includes("</html>")) {
  throw new Error(`dashboard() 输出没有 </html>，模板被提前截断（长度 ${html.length}）`);
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) throw new Error("dashboard() 输出里没有内联脚本");

for (const [i, s] of scripts.entries()) {
  try {
    new Function(s);
  } catch (e) {
    throw new Error(`内联脚本 #${i} 编译失败：${e.message}`);
  }
}

console.log(`check-inline: OK（HTML ${html.length} 字节，内联脚本 ${scripts.length} 段全部可编译）`);
