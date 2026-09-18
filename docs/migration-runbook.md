# Model Hub 迁移顺序

1. 备份现有 PostgreSQL，并记录当前 AiOnline 容器镜像和 compose 配置。
2. 部署 molingapi 到独立目录和独立端口；不要覆盖 `/opt/www-moling-fun/source`。
3. 用 `migrate-live-model-hub.cjs` 导入 provider、key、模型和绑定。导入使用新 schema，不删除源数据。
4. 通过管理台检查 provider key 只显示 `***` 加末四位，检查可用模型目录和线路绑定。
5. 运行 healthz 和只读 smoke；配置测试 provider 后再做单模型生成、SSE 和取消验收。
6. AiOnline 服务端通过内部令牌调用 `/v1/generations`，浏览器仍只请求 AiOnline `/api/*`。
7. 先灰度单个用户或单个模型，观察任务失败、路由和上游限速，再逐步放量。
8. 任一异常都关闭 AiOnline 的 `MODEL_RELAY_ENABLED`，保留 molingapi 以便排查；观察稳定后再删除旧直连逻辑。

## 安全操作

- 不把 GitHub PAT、root 密码、内部令牌或 master key 写进仓库、命令历史、日志和导出 JSON。
- GitHub PAT 曾经在聊天中暴露，应立即撤销并重新生成最小权限 token。
- 服务器 root 密码也曾经暴露，部署完成后立即轮换；后续使用 SSH key 和最小权限部署用户。
- provider key 只通过管理 API 或服务器端迁移脚本写入；不要在浏览器 network、HTML、前端 bundle 或导出文件出现明文。
