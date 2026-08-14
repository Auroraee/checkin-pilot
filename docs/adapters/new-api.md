# New API 签到适配器契约

状态：基于官方主线与已发布版本的研究草案  
更新日期：2026-07-31

## 能力探测

先请求：

```http
GET /api/status
```

关注 `data.version`、`data.checkin_enabled`、`data.turnstile_check` 和 `data.turnstile_site_key`。低于 v0.10.5 的原版部署没有标准签到 API；第三方 fork 仍可能偏离该契约。

截至官方主线 commit `df43f801536b348b00bfa4da7639b42c2c036821`，标准协议没有 PoW challenge、nonce 或 `pow_mode`。若站点前端出现这些字段，应将其识别为站点私有扩展，不归入通用 New API 契约。

## 状态查询

```http
GET /api/user/checkin?month=YYYY-MM
```

成功响应的 `data.stats.checked_in_today` 表示服务端判定的今日签到状态。日期边界以站点服务端时间为准，不应由客户端自行推断。

## 执行签到

```http
POST /api/user/checkin
```

若站点启用 Turnstile，官方前端将令牌放入查询参数：

```http
POST /api/user/checkin?turnstile=<token>
```

业务错误可能使用 HTTP 200 并返回 `success: false`，因此适配器必须同时检查 HTTP 状态、JSON `success` 与 `message`。“今日已签到”应归一为幂等成功，而不是需要重试的失败。

## 鉴权支持边界

- v0.10.5 至 v1.0.0-rc.10 一类已发布部署可以使用浏览器 session，但仍无条件要求 `New-Api-User: <用户 ID>` 与 session 用户匹配；`/api/user/self` 与签到接口都经过同一鉴权，因此不能在未知 ID 时只凭 Cookie 调 `/self` 发现 ID。
- 当前官方主线改为通过 `Authorization` 传递 dashboard access token，没有 Cookie session fallback。该变体由独立的 `same-origin-refresh` 鉴权模式支持（见 `docs/modern-new-api-auth.md`）：扩展在精确同源标签页的 ISOLATED world 中调用 `/api/user/auth/refresh`，Bearer Token 只存在于注入函数的局部变量，绝不进入扩展消息、存储、日志或通知；不新增 `cookies`、`webRequest`、`debugger` 或 `<all_urls>` 权限。临时标签始终关闭，用户已有标签绝不被关闭。
- 普通 `sk-...` 模型调用密钥不是面板签到凭据，不能混用。

适配器不在鉴权变体间自动选择，也不读取或设置 `Authorization`。站点登记时先探测现代鉴权（refresh 成功即现代；401 表示需要登录而非不兼容；只有 refresh 明确返回 404/405 才回退旧式 session 探测），再以 `credentials: include`、`New-Api-User` 和只读签到状态请求验证 session 绑定；Chrome 网络栈会自动携带 Cookie，但扩展不申请 `cookies` 权限、不调用 `chrome.cookies`，也不读取 Cookie 值。旧式会话路径下若站点要求 Token 而 refresh 协议不存在，则标记为不支持。

## 用户 ID 来源

部分前端将数字 ID 单独保存在 `localStorage.uid`；旧版或 fork 则只在 `localStorage.user` JSON 中保存 `.id`，而该对象在非标准部署中可能还包含 Token 字段。首版优先读取独立 `uid`；没有 `uid` 时，由页面上下文中的窄函数解析 `localStorage.user`，只向扩展返回经校验的正整数 `.id`。原始 JSON 与其他字段不得进入扩展消息、日志或存储；该选择已明确接受页面函数可能短暂解析同一对象内其他字段的风险。

## 推荐任务流程

1. 请求 `/api/status`，确认站点可达并识别签到与挑战配置。
2. 探测现代鉴权（同源标签页 ISOLATED world 中 refresh）；成功后以 refresh 返回的账号作为绑定身份，随后在同一注入中完成签到。refresh 返回 404/405 时回退旧式 session 流程：取得候选数字用户 ID，以 session、`New-Api-User` 和只读签到状态请求验证绑定。
3. 请求当月签到状态。
4. 如果 `checked_in_today` 为真，记录为“已签到（成功）”并结束。
5. 如果未签到且无需挑战，执行一次 POST。
6. 如果需要 Turnstile，记录“需用户交互”，打开站点签到页或发出通知，不自动绕过挑战。
7. 对 401/403 或返回登录 HTML 的情况，记录“登录已失效”；现代鉴权下当天停止且只通知一次，次日计划批次再尝试一次，重新登录后自动恢复；旧式 session 站点首次 401 后暂停并提示更新登录方式。对 429 尊重 `Retry-After`；只对网络错误与部分 5xx 做有界重试。

## 官方依据

- Routes: https://github.com/QuantumNous/new-api/blob/main/router/api-router.go
- Controller: https://github.com/QuantumNous/new-api/blob/main/controller/checkin.go
- Status: https://github.com/QuantumNous/new-api/blob/main/controller/misc.go
- Frontend: https://github.com/QuantumNous/new-api/blob/main/web/src/components/settings/personal/cards/CheckinCalendar.jsx
- Authentication: https://github.com/QuantumNous/new-api/blob/main/middleware/auth.go
- Turnstile: https://github.com/QuantumNous/new-api/blob/main/middleware/turnstile-check.go
- Fixed official commit without check-in PoW: https://github.com/QuantumNous/new-api/commit/df43f801536b348b00bfa4da7639b42c2c036821
