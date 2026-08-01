# Sub2API 站点适配边界

状态：官方主线研究结论  
更新日期：2026-07-31

## 结论

截至研究所核对的官方主线，Sub2API 没有标准每日签到 API。官方用户路由包含资料、密钥、用量、兑换码和订阅等能力，但不包含 check-in/sign-in 路由。

因此：

- 不能因为站点被识别为 Sub2API，就推断存在统一签到端点。
- 某个 Sub2API 风格站若显示“签到”，应视为站点私有扩展，建立站点级适配器。
- 开发站点级适配器前，需要真实站点 URL，或用户在 DevTools Network 中提供一次手动签到的脱敏请求样本。

## 官方面板鉴权背景

Sub2API 登录端点为 `POST /api/v1/auth/login`，受保护接口使用 `Authorization: Bearer <JWT>`。官方前端在 localStorage 中维护访问令牌、刷新令牌与过期时间；服务端部署还可能启用 IP/User-Agent 会话绑定。

这些令牌不等于“存在通用签到 API”，也不应由工具索取用户密码后自行登录。首版不读取或存储 Sub2API JWT；只能依赖 JWT 的官方主线及任何 Token-only 私有签到部署均标记为不支持。未来若要改变该边界，必须作为新的安全决策另行评审，不能由站点适配器自行放宽。

## 适配所需的最小样本

- 站点 origin，例如 `https://example.com`；
- 手动签到请求的 URL 与 Method；
- 必要 Header 的名称，不需要真实值；
- Body 字段名称，敏感值打码；
- 成功、已签到、未登录三类响应的脱敏结构；
- 是否出现 Turnstile/CAPTCHA/Cloudflare 页面。

## 官方依据

- Authentication routes: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/auth.go
- User routes: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/user.go
- JWT middleware: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/middleware/jwt_auth.go
- Frontend authentication: https://github.com/Wei-Shaw/sub2api/blob/main/frontend/src/api/auth.ts
