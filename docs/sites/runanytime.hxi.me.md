# runanytime.hxi.me 站点观察

状态：只读观察，未执行签到  
观察日期：2026-07-31

## 已确认

- 控制台入口：`https://runanytime.hxi.me/console/personal`
- 页面标题：随时跑路公益站
- 页面生成器标记：`new-api`
- 个人设置页显示 New API 内置的“每日签到”卡片。
- 观察时当日已经签到，因此签到按钮处于禁用状态；没有再次提交签到请求。
- 公开前端包使用 `GET /api/user/checkin?month=...` 查询，并以 `POST /api/user/checkin` 执行签到。
- 该前端签到模块同时支持 Turnstile 与 PoW 安全检查；POST 查询参数可能包含 `turnstile`、`pow_challenge` 和 `pow_nonce`。
- 当前 New API 官方主线没有签到 PoW 协议，因此该站属于带私有签到扩展的 New API 部署，不能仅依赖通用适配器完成所有安全模式。
- 公开前端包中的签到请求使用当前站点登录 session，并附带 `New-API-User: <user.id>`；签到调用没有 Bearer `Authorization` 请求头。
- `user.id` 来自页面保存的登录用户资料。登记时允许页面上下文中的窄函数只返回经校验的数字 `.id`；原始 `localStorage.user` JSON 不得传给扩展、记录或持久化。真正的认证能力来自 Chrome 自动随请求携带、扩展代码不读取其值的站点 Cookie。
- 私有 PoW 流程由 `GET /api/user/pow/challenge?action=checkin` 返回 `challenge_id`、`prefix` 与 `difficulty`，前端计算 nonce 后随签到 POST 一并提交。
- 2026-07-31 的公开 `/api/status` 返回 `checkin_enabled: true`、`pow_enabled: true`、`pow_mode: "replace"`、`turnstile_check: true`；`replace` 表示本次签到由 PoW 替代 Turnstile。公开状态不含 PoW difficulty、TTL 或 expiry。

## 仍需真实验证

- 该站采用已确认的 session、`New-API-User` 与私有 `replace` PoW 契约；详见 [`../adapters/runanytime-pow.md`](../adapters/runanytime-pow.md)。
- challenge 的 difficulty 只能在登录后取得，TTL/expiry 不公开；服务端过期错误与实际奖励响应仍需在站点状态显示尚未签到的调度日，通过一次真实后台签到验证。
- 真实验证不得读取、记录或提交用户的密码、Cookie 值或令牌。
