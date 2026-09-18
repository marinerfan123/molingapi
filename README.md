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
# 墨灵中转站（molingapi）

独立承载墨灵 Model Hub 的服务：provider、密钥池、模型目录、线路绑定、路由和异步任务。AiOnline 继续负责用户、余额、媒体、OSS 和支付。

## 当前能力

- 独立 `/v1/models`、`/v1/generations`、任务查询、SSE 和取消接口。
- provider/key/model/binding 管理 API 和一个轻量管理台。
- provider key 使用 AES-256-GCM 加密存储，HTTP 响应只返回掩码。
- `(userId, idempotencyKey)` 幂等提交、owner 校验、终态保护和 revision 乐观锁。
- `model_relay` 独立 PostgreSQL schema；可从线上 AiOnline Model Hub 安全迁移且不改源表。

## 本地运行

```bash
npm install
copy .env.example .env
npm test
node server/server.js
```

开发时如只想启动无数据库管理台，可设置 `MODEL_RELAY_ALLOW_MEMORY=true`；生产环境不允许内存降级。

## API 示例

```bash
curl http://127.0.0.1:3010/v1/models \
  -H "Authorization: Bearer $MODEL_RELAY_INTERNAL_TOKEN" \
  -H "x-user-id: user-1"
```

完整部署和线上迁移步骤见 `docs/deployment.md` 与 `docs/migration-runbook.md`。
