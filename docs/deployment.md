# 墨灵中转站部署

## 1. 配置

复制 `.env.example` 为服务器上的 `.env`，填入现有 PostgreSQL 的连接信息，并生成三类服务端令牌：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`MODEL_RELAY_MASTER_KEY` 只用于 provider key 的 AES-256-GCM 封装，必须备份在密码管理器中；丢失后无法解密已有 key。`MODEL_RELAY_INTERNAL_TOKEN` 只给 AiOnline 服务端，`MODEL_RELAY_ADMIN_TOKEN` 只给管理台管理员。

## 2. 启动

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl http://127.0.0.1:3010/api/healthz
```

生产启动会先连接 PostgreSQL，再创建 `model_relay` schema 和表；连接失败或令牌缺失会直接退出，不使用内存数据替代。

## 3. 从现有 AiOnline Model Hub 迁移

新服务使用独立的 `model_relay` schema，不覆盖 AiOnline 的 `public` 表。迁移脚本在服务器上执行时读取已有 Hub 的 provider、模型、绑定和 key，并在写入新 schema 时即时加密 key：

```bash
docker compose -f docker-compose.prod.yml exec molingapi node scripts/migrate-live-model-hub.cjs
```

脚本只输出数量统计，不输出 key。迁移前应完成 PostgreSQL 备份；迁移不会删除或更新 AiOnline 的源表。

## 4. 验收与回滚

```bash
MODEL_RELAY_URL=http://127.0.0.1:3010 \
MODEL_RELAY_INTERNAL_TOKEN=... \
node scripts/smoke-model-relay.mjs
```

先只验证模型目录。设置 `MODEL_RELAY_SMOKE_GENERATE=true` 前，应确认首个模型是测试 provider，避免产生真实上游费用。AiOnline 灰度接入失败时，将其 `MODEL_RELAY_ENABLED` 设为 `false`，回退到原 `/api/generate` 路径；不要删除 `model_relay` schema 或源表。
