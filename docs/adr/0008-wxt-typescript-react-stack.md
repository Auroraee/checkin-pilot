---
status: accepted
---

# 使用 WXT、TypeScript 与 React 构建扩展

首版以 WXT 生成 Chrome Manifest V3 的 background、popup、options、offscreen 页面和可分发 ZIP，使用 TypeScript 约束适配器与跨上下文消息，并以 React 实现 popup 和设置页。签到调度、站点适配器、数据模型与 PoW 协议保持 UI 框架无关，依赖版本由锁文件固定，以降低构建工具锁定和供应链漂移风险。
