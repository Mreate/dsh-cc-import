# 编码约定

- 模块边界：host 半在 src/，client 半在 client/。
- 导入器走 ImportProvider 抽象，新增 Agent 只加 provider 实现。
- 事件数据必须是 lossless JSON（剔除 undefined 字段）。
