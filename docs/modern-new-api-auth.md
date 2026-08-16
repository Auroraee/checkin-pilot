# 现代 New API 鉴权与自动签到改造

状态：决策基线；实现已完成并通过验收（unit、mock-e2e、typecheck、build、安全扫描），见文末“实现记录”  
记录日期：2026-08-12

## 摘要

- 目标：让 CheckinPilot 在 Chrome 114+ 中真正自动签到，同时兼容旧 Cookie Session 与新版 Bearer 鉴权。
- 根因：runanytime 的签到接口仍存在，但已迁移至短期 Bearer Token；扩展仍使用 `Cookie + New-Api-User`，导致 401 被误判成“不兼容”。
- 交付标准：面向公开发布；后续实现代码、测试和文档，不生成发布 ZIP。
- 参考：[New API 鉴权说明](https://github.com/QuantumNous/new-api/blob/main/docs/authentication.md)、[Chrome 隔离脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[站点状态](https://runanytime.hxi.me/api/status)。

## 已确认的现场证据

- `GET /api/status` 返回 200，且包含 `checkin_enabled: true`、`pow_enabled: true`、`pow_mode: "replace"`、`turnstile_check: true`；网站并未关闭签到。
- `GET /api/user/checkin?month=2026-08` 返回 `401 AUTH_UNAUTHORIZED`；添加旧式 `New-Api-User` 请求头仍然返回相同结果。
- 当前扩展在公共能力探测成功后，又要求受保护的签到状态请求成功；该请求只携带 Cookie 与 `New-Api-User`，因此把新版鉴权的 401 错误折叠成 `supported: false`，最终显示“未检测到兼容的签到接口”。
- 新版 New API 使用约 15 分钟有效的内存 Access Token，以及由浏览器保存的 `HttpOnly; SameSite=Strict` Refresh Cookie。生产环境的 refresh Origin 校验决定了通用实现必须从精确同源页面发起请求。

## 核心设计

- 新增独立鉴权模式：`legacy-session`、`same-origin-refresh`、`none`；协议适配器与鉴权方式解耦。
- 新式鉴权在精确同源标签页的 `ISOLATED` world 中完成：
  - 调用 `/api/user/auth/refresh`。
  - Bearer Token 只存在于注入函数局部变量。
  - Token 不进入扩展消息、后台、日志、异常或存储。
  - 不新增 `cookies`、`webRequest`、`debugger` 或 `<all_urls>` 权限。
- 优先复用已有同源标签；没有时创建 `active:false` 临时标签，任何结果下均关闭；绝不关闭用户已有标签。
- 探测现代鉴权优先；只有 refresh 明确返回 404/405 或协议不存在时才回退旧式鉴权。401 表示需要登录，不是不兼容。
- 每次 refresh 都校验返回账号与绑定账号一致；账号变化必须单独确认重绑。

## 签到、迁移与体验

- 普通签到在一次隔离注入中完成 refresh、状态查询和提交。
- runanytime PoW 在同一次隔离注入中保持短期 Token：
  - 获取 challenge 后，仅将 `prefix/difficulty/challengeId` 发送给现有 offscreen solver。
  - 后台返回 nonce，页面立即提交。
  - 保留每次 12 秒、每日 2 个 challenge/24 秒、难度 10–20 的限制。
  - 该长注入链在 Chrome 114+ 中机制上可行，但实现时必须为异步消息监听同步 `return true`，并按 `target/type/taskId` 严格路由。
  - 若长注入在真实 Chrome 中出现导航、消息通道或生命周期不稳定，则改用两段短注入：第一段 refresh 并取 challenge，后台求解后第二段重新 refresh、复核账号并提交；Bearer 仍不得跨出页面上下文。
- Turnstile 站点允许添加；已签到可确认成功，未签到则关闭临时页并通知人工处理。
- 未知私有挑战不猜测协议，明确标记不支持自动化，并可让用户另选访问模式。
- 访问模式继续保留，但结果改为独立的“未验证”终态：不算成功、不重试、不发成功通知。
- Schema 升级到 v2，并显式迁移全部设置、站点、历史、任务、重试和 PoW 账本：
  - 已有 runanytime 立即暂停，通知一次“更新登录方式”。
  - 其他旧站继续旧式鉴权；首次 401 后暂停并提示更新。
  - 更新入口是在站点页点击改名后的“更新当前网站”。
- “添加当前网站”视为授权，不增加二次确认；按钮旁常驻说明临时后台页和 Token 安全边界。
- refresh 401 后当天停止且只通知一次；以后每天尝试一次，重新登录后自动恢复。
- Chrome 完全退出或电脑关机时不承诺执行；启动后沿用现有补跑机制。

## 类型与测试

- 增加 `AuthMode`、现代鉴权身份来源、`auth_upgrade_required` 和“未验证”结果；所有消息实施逐分支运行时校验。
- 将认证网络访问抽象成固定操作 transport，禁止通用原始 HTTP 或 Token RPC。
- 补齐真实 `tests/mock-e2e`，覆盖：
  - 旧 Session 与现代 Bearer New API。
  - runanytime PoW 成功、超时和预算耗尽。
  - 账号变化、refresh 失效、Turnstile、未知挑战。
  - 临时标签复用、导航竞态与清理。
  - v1→v2 无损迁移和一次性升级通知。
  - Sentinel Token 不出现在消息、存储、日志、通知或快照。
- 验收运行 unit、mock-e2e、typecheck、build 和安全扫描；不执行 ZIP 打包。
- 实现后由用户在未签到日触发一次真实 runanytime 签到，验证 PoW、服务端结果及临时标签清理。

## 固定假设

- 仅支持 Chrome 114+，不扩展 Edge 或 Firefox。
- 同一 origin 仍只绑定一个当前浏览器账号。
- 不支持持久 PAT，也不读取或保存 HttpOnly Refresh Cookie。
- 今天只保留本决策记录，不修改实现。

## 本次记录边界

- 决策记录当日仅新增本决策文档，没有修改扩展源代码、配置、测试或现有产品文档。
- 后续实现开始前，应先确认工作区状态并以本文档作为决策基线；若改变凭据边界、标签页行为、迁移策略或兼容范围，应先更新本文档或新增 ADR。

## 实现记录（2026-08-12）

实现按本文档基线落地，主要产物：

- `src/auth/`：固定操作 transport 抽象（`AuthTransport.runCheckinFlow`）、共享流程 `flow.ts`、`legacy-session` 与 `same-origin-refresh` 两种实现、页面会话管理（复用/创建/关闭临时标签）、ISOLATED world 注入脚本（`refresh-script.ts`，Bearer 仅存于注入函数局部变量）、现代优先探测编排。实测 runanytime 的 refresh 端点为 `POST /api/user/auth/refresh`（返回 `data.access_token`、`token_type`、`data.user.id`）；注入脚本 POST 优先、GET 兜底，仅当两种方法都 404/405 才判定协议不存在并回退旧式探测。
- `src/adapters/`：协议适配器与鉴权方式解耦；`new-api`、`runanytime` 协议只依赖 transport；旧式 session 探测作为 refresh 404/405 时的回退。
- `src/pow/`：offscreen 消息增加 `target` 严格路由；页面 PoW 请求按 `target/type/taskId` 校验后由后台转发到现有 offscreen solver，预算记账保持每日 2 次/24 秒/难度 10–20。
- Schema v2：显式迁移设置、站点、历史、任务、重试与 PoW 账本；runanytime 迁移即暂停并触发一次性“更新登录方式”通知；旧站首次 401 后暂停并提示更新；refresh 401 当日停止、只通知一次，次日计划批次重试一次，重新登录后自动恢复。
- 访问模式结果改为独立 `unverified` 终态（不算成功、不重试、不发成功通知）。
- 弹窗“添加当前网站”在已添加站点时改名为“更新当前网站”，按钮旁常驻临时后台页与 Token 安全边界说明。
- 测试：`tests/mock-e2e`（旧/新鉴权、PoW 成功/超时/预算耗尽、账号变化、refresh 失效、Turnstile、未知挑战、标签复用与清理、导航竞态、v1→v2 迁移与一次性通知、Sentinel Token 不出现在消息/存储/日志/通知/快照），以及受影响的单元测试更新。
- 验收命令：`pnpm typecheck`、`pnpm test`（unit + mock-e2e）、`pnpm build`、`pnpm check:secrets`，全部通过；不生成发布 ZIP。
- 真实站点验证仍按上文“交付标准”由用户在未签到日触发一次真实 runanytime 签到完成（PoW、服务端结果与临时标签清理）。

## 更新（2026-08-16）：服务工作线程静默优先

产品需求变更：除访问模式外，签到与探测尽量不打开目标站点标签页。

- `same-origin-refresh` 新增静默优先路径（`ModernSilentTransport`）：refresh、状态、挑战、提交全部由扩展 service worker 凭借已授予的 host 权限发起，Cookie 照常附带；Bearer 值仅存于 transport 局部变量，仍不进入扩展消息、存储、日志或通知。
- 静默 refresh 返回未认证（401/403/重定向/HTML）时，回退到本文描述的同源页面会话流程：这覆盖生产环境校验 refresh Origin 的部署（如 runanytime 的实测行为），回退时才创建 `active:false` 临时标签、用后即关，确认未登录时的结果与通知策略不变。
- 探测同样静默化：不再复用或创建标签页即可判定现代鉴权能力与当前账号；仅旧式回退仍需页面身份读取。
- 访问模式（`visit-open`）不受影响，仍按计划打开站点标签页约 15 秒。
