# 自动签到工具：需求发现记录

状态：访谈进行中  
更新日期：2026-07-31

## 初始目标

为采用 New API 或相近面板架构的第三方站点提供自动签到能力。最终交付形态确定为可在 GitHub 公开源码并分发的 Chrome Manifest V3 扩展。

## 已确认事实

- 当前工作区为空，项目将从零开始。
- New API 已在 v0.10.5 系列加入用户签到功能。标准路由为 `GET /api/user/checkin?month=YYYY-MM`（查询）和 `POST /api/user/checkin`（签到），但站点默认可关闭该功能，且具体部署可能修改接口。
- New API 可通过匿名 `GET /api/status` 探测版本、签到开关与 Turnstile 配置。启用 Turnstile 时，完全无人值守签到不可作为承诺。
- New API 的面板鉴权在已发布版本与当前主线间存在差异；工具必须做能力/版本探测，不能把普通模型 API Key 当作网页面板凭据。
- “sub spi”指 Sub2API。Sub2API 官方主线没有通用每日签到路由；具有签到功能的 Sub2API 风格站大概率是二次开发，必须按真实站点契约适配。
- 已有 AGPL 项目 All API Hub 覆盖 New API、Sub2API、多账号与计划签到；本项目已决定从零实现，不复制其代码，以维持已确认的单会话账号、最小权限和非商业许可边界。
- 自动签到依赖目标站点的登录态、接口兼容性以及验证码或 Cloudflare 等交互式挑战。

## 首轮结论

首轮问题已经解决：

1. 首要目标是满足用户自己的签到需求，同时在 GitHub 公开源码并分发。
2. “sub spi”是 Sub2API；首个示例站点是 `https://runanytime.hxi.me/console/personal`。
3. 只要求 Chrome 正在运行时执行；某日全天未打开浏览器则直接错过，不补签。

## 当前访谈分支

- 站点加入与权限边界已确认：只处理用户主动加入并逐 origin 授权的站点；不扫描全部网页，不申请 `<all_urls>`。
- 账号与凭据边界已确认：每站绑定当前 Chrome 配置中的一个账号，仅复用现有登录会话，不持久化认证秘密。
- 用户 ID 登记边界已确认：优先读取独立 `uid`；否则允许页面上下文窄函数解析 `localStorage.user` 并只返回经验证的数字 `.id`，原始对象和其他字段不进入扩展消息、日志或存储。
- 安全挑战边界已确认：自动处理已知且有界的 PoW；Turnstile、CAPTCHA 与未知挑战只通知，用户点击后才打开页面。
- 当日补跑语义已确认：计划时 Chrome 未运行时，可在同一浏览器本地调度日稍后启动后补跑；从不跨调度日补跑。
- 时钟模型已确认：“当天”指 Chrome 所在设备的本地调度日；每天只生成一个全局随机批次，站点返回状态是服务日资格的权威，首版不提供逐站时区。
- 调度形式已确认：默认按用户本地时间在 08:00–10:00 的签到窗口内随机执行，晚于窗口启动则当日补跑。
- 配置粒度已确认：所有站点共用一个全局签到窗口，每个站点可独立启用或暂停；首版不提供逐站时间覆盖。
- 多站点策略已确认：签到批次串行处理，站点之间随机间隔 5–15 秒；需要人工介入的站点不阻塞后续站点。
- 重试边界已确认：网络中断、429 与 5xx 最多重试两次（5 分钟、30 分钟，尊重 Retry-After）；每次先复查状态且不跨浏览器本地调度日，其他终止结果不自动重试。
- 通知策略已确认：成功和已签到仅更新扩展状态与历史；需要用户介入或最终失败才默认发送系统通知，成功通知可选开启。
- 数据边界已确认：完全本地、零遥测；脱敏签到记录保留 30 天且每站最多 100 条，不保存认证信息或原始响应。
- 首版兼容范围已确认：runanytime.hxi.me 为已验证适配；会话鉴权与标准接口探测成功的 New API 为探测兼容；Token-only New API 与未适配的 Sub2API 签到不支持。
- 界面边界已确认：popup 负责日常操作与逐站状态，设置页负责全局配置、站点管理和 30 天记录；不注入站点悬浮 UI，不做全屏仪表盘。
- 暂停语义已确认：暂停仅排除计划签到与当日补跑；单站手动签到仍可用，“全部立即签到”只包含已启用站点。
- 站点登记流程已确认：用户先登录并从当前站点发起，逐 origin 授权后探测能力，展示鉴权/安全信息，再次确认才启用自动签到；粘贴 URL 只引导打开站点。
- 账号切换已确认：登录身份与保存用户 ID 不一致时停止自动化并要求用户介入，只有显式“重新绑定当前账号”才能改绑。
- 重绑历史已确认：新账号创建新的绑定代次；旧代次记录保留至 30 天到期，标记为先前账号且不参与当前汇总。
- 移除语义已确认：二次确认后取消待处理工作，删除全部绑定/配置/记录并撤销 origin 权限；唯一例外是只含 origin、调度日与已用次数/秒数的 PoW 安全预算墓碑，它防止同日重加绕过上限并在本地午夜自动删除。
- 发布顺序已确认：GitHub 公开源码与可复现 Release ZIP 首发；完成连续实测后再准备 Chrome Web Store，不让商店审核阻塞自用。
- 许可决定已确认：采用 PolyForm Noncommercial 1.0.0，允许个人及许可证列明的非商业组织使用、修改和分发，商业使用需另行授权；项目属于“源码可用（source-available）”，不使用“开源（open source）”作为正式定位。
- 工程技术栈已确认：采用 WXT、TypeScript 与 React；核心签到逻辑保持与 React 解耦，扩展包内包含 offscreen 页面与专用 PoW Worker。
- 运行环境最低为 Chrome 114，以使用 `WORKERS` 类型的 offscreen document 承载专用 PoW Worker。
- 界面语言已确认：首版提供简体中文和英文，自动跟随 Chrome 界面语言，不支持的语言回退简体中文；首版不提供手动语言切换。
- PoW 资源上限已确认：只自动处理难度 10–20；单 Worker 每个 challenge 最多计算 12 秒。每个 origin、每个本地调度日最多两次 challenge、累计 24 秒，计划、补跑、重试与扩展内手动触发共享预算，重绑或暂停恢复不能重置，首版不可调高。
- 首版验收标准已确认：通过可复现构建和自动化/Chrome 测试后生成 RC；在 runanytime.hxi.me 完成一次真实自动签到后发布 GitHub v0.1.0；连续稳定运行 7 个 Chrome 开启日后才进入 Chrome Web Store。
- 产品名称已确认：`CheckinPilot`；中文展示名为“CheckinPilot 自动签到”，GitHub 仓库名为 `checkin-pilot`。
- 外部贡献策略已确认：开放 Issue 与 Pull Request，代码贡献沿用 PolyForm Noncommercial 1.0.0，贡献者保留版权，不签 CLA，维护者不取得单方面商业再许可权。
- 许可证公开署名与 GitHub 仓库 owner 已确认使用 `Auroraee`；目标仓库地址为 `https://github.com/Auroraee/checkin-pilot`，许可证 Required Notice 使用该公开身份而不额外展示真实姓名。
- 当前待确认：最终一致性审计通过后，对完整方案作共同理解总确认；确认后才开始实现。

## 已确认安全边界

- 不采集或保存站点密码。
- 只复用浏览器现有登录会话，不持久化访问令牌、Cookie、密码或 API Key。
- 不承诺自动绕过验证码、Turnstile 或其他反自动化挑战；遇到挑战时应暂停并通知用户处理。
- 对每个站点进行最小权限授权，并提供清晰的权限说明。

## 参考项目

- New API: https://github.com/QuantumNous/new-api
- New API check-in controller: https://github.com/QuantumNous/new-api/blob/main/controller/checkin.go
- New API routes: https://github.com/QuantumNous/new-api/blob/main/router/api-router.go
- Sub2API: https://github.com/Wei-Shaw/sub2api
- Sub2API user routes: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/user.go
- All API Hub: https://github.com/qixing-jk/all-api-hub
