# groq-proxy

Groq API 反向代理，跑在 Cloudflare Workers 上。**服务端持有 key 号池**，客户端只拿一把代理令牌——适合多账号轮换、规避单账号限流，以及从不能直连 `api.groq.com` 的网络里调用 Groq。

## 特性

- **号池轮询**：Secret 里的多把 key + 管理台加进 KV 的 key 合并成一个池，随机起点选取，长期分布均匀
- **智能重试**：命中 `429`（该 key 限流）或 `401`（该 key 失效）时换下一把 key 重试，同一次请求内完成，客户端无感；`403` 不重试（Groq 的 403 按客户端来源国判定，与 key 无关，换 key 只会放大上游请求）
- **失效 key 冷却**：429 按上游 `retry-after` 冷却（上限 5 分钟），401 冷却 5 分钟，冷却期内排到最后
- **运行时增删 key**：管理台粘贴即加（KV 存储，无需重新部署）；格式校验 + 重复检测 + 写前合并，避免覆盖他人刚加的号
- **单一出口令牌**：对外只认 `PROXY_TOKEN`，真实 key 永不出 Worker（响应里只回尾 4 位）
- **路径原样透传**：`/openai/v1/...` → `https://api.groq.com/openai/v1/...`，与 OpenAI SDK 完全兼容
- **流式不缓冲**：SSE 原样透传；请求体读入内存是为了支持换 key 重试
- **上游超时**：120 秒，避免请求悬空
- **管理台**：`/admin` 单密码登录（密码即 `PROXY_TOKEN`），号池状态、逐 key 探活与实时限额、模型清单、对话测试、Key 增删
- **零运行依赖**：只用 Workers 原生 API

## 快速开始

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc   # 然后按注释填 KV id / 域名

# 1) 写入号池（逗号分隔，多把 key）
printf 'gsk_aaa,gsk_bbb' | npx wrangler secret put GROQ_KEYS

# 2) 写入对外令牌（客户端用这把，不是 Groq key）
printf 'your-own-proxy-token' | npx wrangler secret put PROXY_TOKEN

# 3) 创建 KV（管理台自助增删 key 用；跳过则号池固定为 GROQ_KEYS）
npx wrangler kv namespace create KEYS_KV

# 4) 部署
npx wrangler deploy
```

## 客户端用法

`base_url` = `https://<你的域名>/openai/v1`，`api_key` = `PROXY_TOKEN` 的值。

```bash
curl "https://<your-domain>/openai/v1/chat/completions" \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"hi"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://<your-domain>/openai/v1", api_key="YOUR_PROXY_TOKEN")
r = client.chat.completions.create(
    model="openai/gpt-oss-20b",
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)
```

语音转写（Whisper）同样走这个 base_url：

```bash
curl "https://<your-domain>/openai/v1/audio/transcriptions" \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -F file=@sample.wav -F model=whisper-large-v3-turbo
```

> 有些客户端（如只列举聊天模型的选择器）看不到 whisper——它们的 `output_modalities` 是 `["transcription"]` 而非 `text`，被客户端自己过滤了，接口本身可用。

## 管理台

打开 `https://<你的域名>/admin`，输入密码（= `PROXY_TOKEN`），登录态存 7 天 HttpOnly Cookie。

| 功能 | 说明 |
|---|---|
| 概览 | 号池规模、健康 key 数、剩余请求额度合计、可用模型数、平均延迟 |
| Key 状态 | 逐 key 探活：状态码、延迟、请求额度进度条、token 剩余、reset 倒计时，标注来源（Secret / 管理台） |
| Key 管理 | 粘贴添加 key（格式校验 + 重复检测，写入 KV 即时生效）；管理台来源的 key 可点删除 |
| 模型清单 | 从 `/models` 拉取，按模态打标（聊天 / 视觉 / 音频转写 / 语音合成 / 内容安全） |
| 对话测试 | 页面上直接发一句话验证号池 |
| 接入配置 | base_url 一键复制 + curl / SDK 示例 |

`curl` 等非浏览器场景仍可用 Basic 鉴权：`curl -u ":${PROXY_TOKEN}" https://<域名>/admin/api/state`。

| 路径 | 方法 | 说明 |
|---|---|---|
| `/admin` | GET | 登录页 / 管理台 |
| `/admin/login` | POST | 表单登录（`password` 字段） |
| `/admin/logout` | POST | 退出 |
| `/admin/api/state` | GET | 号池状态（含每个 key 的来源与 id） |
| `/admin/api/test` | POST | 逐 key 探活（并发） |
| `/admin/api/keys/add` | POST | 添加 key，body `{keys:"gsk_a,gsk_b"}`，返回 added / duplicate / invalid |
| `/admin/api/keys/delete` | POST | 删除 key，body `{id:"..."}`（仅 KV 来源可删） |
| `/admin/api/models` | GET | 模型清单 |
| `/admin/api/chat` | POST | 最小对话测试，body `{model, prompt}` |
| `/` `/__pool` | GET | 号池概览（不含完整 key） |

### 号池存储与一致性

- 静态池来自 Secret `GROQ_KEYS`（只读，改要重新 `wrangler secret put`）
- 动态池存在 KV 的 `pool` 键，管理台增删都写这里
- KV 是**最终一致**的：同一 Cloudflare 边缘位置写入后立即读到；跨位置最长约 60 秒收敛。写入路径会先取 KV 最新内容再合并，不会用旧快照覆盖别人的新增；读路径带 30 秒缓存与写入覆盖层
- 未绑定 `KEYS_KV` 时，`/admin/api/keys/*` 返回错误，号池退化为只用 Secret

## 关于中国大陆访问

Groq 会对**客户端来源国**做判定。当客户端在中国大陆直连本 Worker 时，Worker → Groq 的子请求会被 Cloudflare 内网路由带上 CN 的 GeoIP 标签，Groq 直接返回 `403 Forbidden`——这不是 key 失效，改代码、换机房、调 UA、加 `placement` 都无效（已实测）。

可用做法：

- 客户端走境外代理（最简单）
- 让反代跑在固定境外出口的自建 VPS 上

## 备注

- 响应头 `x-groq-proxy-key` 返回本次命中的 key 尾 4 位，`x-groq-proxy-pool` 返回号池规模，便于排查
- `GROQ_KEYS` 支持逗号或空白分隔；只接受 `gsk_` 前缀，脏数据自动忽略
- 免费层额度按 Groq 账号（organization）计，多账号才有实质收益
- 令牌比较走恒定时间实现，登录页不回显令牌片段

## License

MIT
