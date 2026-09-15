# 墨灵中转站（molingapi）

墨灵中转站是从 AiOnline 抽取的模型供给与调度服务，目标是统一管理服务商、API Key 池、模型目录、参数模板、线路绑定、限流、熔断和异步生成任务。

## 当前状态

仓库当前提交的是独立项目边界和实现计划，尚未迁移运行代码。第一阶段保留以下责任边界：

- molingapi：provider、key pool、model、routing、generation task 和管理台
- AiOnline：用户登录、余额、支付、媒体库、角色、参考样式和 OSS

实现计划位于 `docs/superpowers/plans/2026-09-15-molingapi-model-relay.md`。

## 命名

- 产品名：墨灵中转站
- 仓库与服务名：`molingapi`

