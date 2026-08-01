# runanytime.hxi.me 私有签到 PoW 契约

状态：基于 2026-07-31 公开前端包的静态分析  
适用范围：`https://runanytime.hxi.me`，不得当作 New API 通用协议

## Challenge

```http
GET /api/user/pow/challenge?action=checkin
New-API-User: <user.id>
Cookie: <由 Chrome 登录会话自动携带，扩展不读取其内容>
```

成功数据包含：

```json
{
  "challenge_id": "...",
  "prefix": "...",
  "difficulty": 18
}
```

管理界面允许难度 10–30，提示 16 约 1 秒、18 约 3 秒、20 约 10 秒。Challenge 有效期配置范围为 5–300 秒，默认 10 秒。

## 求解算法

从计数器 `0` 开始：

1. 将计数器转换为小写十六进制，并在左侧补零至 8 位，得到 `nonce`。
2. 计算 `SHA-256(UTF8(prefix + nonce))`。
3. 若摘要的前 `difficulty` 个 bit 全为 0，则求解成功；否则递增计数器。
4. 最大计数器为 `0xffffffff`。公开 Worker 每 50,000 次尝试报告一次进度。

## 提交

```http
POST /api/user/checkin?pow_challenge=<challenge_id>&pow_nonce=<nonce>
```

若还需要 Turnstile，则同一请求还会包含 `turnstile=<token>`。

## 模式语义

- `pow_enabled` 与 `pow_mode` 来自公开 `/api/status`；difficulty 来自登录后的 challenge。公开状态不提供 challenge TTL 或 expiry，因此适配器必须在获取后立即计算、立即提交，不能依赖客户端提前知道有效期。
- `replace`：PoW 完全替代 Turnstile，可以进入自动计算。
- `supplement`：PoW 与 Turnstile 都需要，直接标记“需要用户介入”，不先消耗短期 PoW。
- `fallback`：`turnstile_check=true` 时标记“需要用户介入”；否则可以进入自动 PoW。
- `pow_mode` 缺失或未知时按未知挑战处理，不照搬站点前端的默认 `replace` 行为。

## MV3 可行性研究

Manifest V3 extension service worker 不能创建 Dedicated Worker。已确认的实现是：service worker 负责调度、获取 challenge 与提交结果；临时 offscreen document 通过扩展内置的 Dedicated Worker 完成纯计算，任务完成、取消或超时后立即终止 Worker 并关闭 document。

- `WORKERS` offscreen reason 要求 Chrome 114+，因此 manifest 的最低 Chrome 版本设为 114。
- 计算算法必须随扩展打包；远端只能提供 `prefix`、`difficulty` 等数据，不能下发可执行代码。
- 每个 profile 同时只有一个 offscreen document，首版应串行计算并设置硬超时。
- 首版只自动接受难度 10–20；每个 challenge 使用单个 Worker 最多计算 12 秒。计划、补跑、网络重试和扩展内手动触发在每个 origin、每个浏览器本地调度日共用最多两次 challenge、Worker 累计最多 24 秒的硬预算；重绑、暂停恢复和重复点击不重置。获取后必须立即计算并提交，过期或未求解时仅在剩余预算内重新获取一次；耗尽后只复查状态并转为“需要用户介入”。
- Turnstile 仍需要可见页面与用户交互，不能由 offscreen document 或 service worker 静默完成。
- 若公开上架，应清楚披露短时 CPU 使用、提供取消能力并限制并发；该 PoW 不是加密货币挖矿，但仍需避免任何隐藏或无界计算行为。

技术依据：

- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- https://developer.chrome.com/docs/webstore/program-policies/malicious-and-prohibited

## 可核对资源

- 主前端包：`/static/js/index.f86d1d8f45.js`，分析时 SHA-256 为 `40629BE5FD48C2C60090E18FE411032DA6689F54871A8343065A54DF16363DA0`。
- PoW Worker：`/static/js/async/4736.4a9b51ae05.js`，分析时 SHA-256 为 `993E41A7CB619C748630A7295074B64CB2712AA122A5F89F236858846A5BE160`。

静态资源可能随站点发布而变化；适配器应通过契约测试识别破坏性变更，而不是长期依赖文件 hash。
