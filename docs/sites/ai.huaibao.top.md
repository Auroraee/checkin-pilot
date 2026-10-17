# Huainova 签到签名适配

记录日期：2026-09-29。状态：已核对公开客户端协议并完成模拟契约测试，尚未完成登录账号下的真实签到验收。

## 现场证据

- [公开状态](https://ai.huaibao.top/api/status) 返回 `checkin_enabled: true`、`turnstile_check: false`，未声明 PoW。
- [首页引用的公开客户端](https://ai.huaibao.top/assets/index-CZIMelmQ.js) 中，签到按钮先从 `GET /api/user/checkin?month=YYYY-MM` 的 `data.checkin_nonce` 取得 nonce。
- 提交使用 `POST /api/user/checkin`，JSON 请求体为 `{}`。额外请求头为 `X-Checkin-Timestamp`（Unix 秒的十进制字符串）及 `X-Checkin-Signature`（下式的 SHA-256 小写十六进制摘要）：

```text
userId + ":" + timestamp + ":" + checkin_nonce
```

客户端文件 SHA-256：`7b2e23a401cd8093da36bfe3984b9f5b4c6588bcbd05b5c4a9cacdd22a1200b5`。

此前通用 New API 提交未携带以上两个头。协议差异可以解释网页签到可用而扩展收到业务拒绝；没有取得用户账号下的失败响应，因此不将其表述为已完成真实请求复现。

## 实现边界

- 仅精确 origin `https://ai.huaibao.top` 启用该签名协议。其他 New API 部署保持通用请求行为。
- 复用现有授权、会话和绑定账号；每次尝试都先读取最新签到状态，已签到则直接结束。
- nonce 必须是非空且不超过 4096 字符的字符串；缺失或格式不符合预期时停止提交，不猜测替代值。
- 每次提交计算一个 SHA-256 摘要，没有搜索或循环求解。若站点以后要求交互验证或未知 PoW，仍停止并要求用户处理。
- nonce 和签名只存在于本次请求的内存中，不进入扩展消息、历史、日志、通知或快照；同源页面回退路径在注入函数内部完成签名。
- 新增内容不改变持久化结构和站点绑定。已经以 New API 模式登记的站点，加载新构建后即可使用。

## 验证

- 单元测试独立使用 Node SHA-256 核对请求头、时间单位、用户编号与 JSON 请求体。
- 模拟服务器拒绝缺少或错误的签名，覆盖旧会话、现代静默鉴权和页面回退三条路径。
- 覆盖 nonce 缺失、长度限制、已签到跳过、交互验证、账号变化、其他 origin 隔离和敏感临时值不落盘。
- 待用户在未签到的服务日，确认一次扩展签到及站点端实际记录。如果当天已经网页签到，只能验证扩展是否识别为「今日已签到」。
