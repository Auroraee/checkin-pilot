---
status: accepted
---

# 只复用当前浏览器会话

首版每个已授权站点只绑定当前 Chrome 配置中已登录的一个签到账户。登记时优先读取独立的 `localStorage.uid`；没有该值时，允许站点页面上下文中的窄函数解析 `localStorage.user`，但只能向扩展返回经校验的正整数 `.id`，原始 JSON 和其他字段不得跨越页面边界、进入日志或存储。候选 ID 通过只读签到状态请求与当前 session 验证；后台不设置 `Authorization`、不申请 `cookies` 权限且不调用 `chrome.cookies`，仅由 Chrome 网络栈自动附带 Cookie。扩展只保存 origin、非秘密用户 ID 和任务状态；登录失效或身份不匹配时暂停自动化，只有用户从站点页面明确发起重绑才能替换身份。该边界有意排除同站多账号与只能依赖长期 Token 的站点，并接受页面窄函数在第三方 fork 中可能短暂解析同一对象内其他字段的已披露风险。
