# 墨灵中转站（molingapi）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 AiOnline 中抽出“服务商、密钥池、模型目录、参数模板、智能路由和异步生成任务”，形成可独立部署的“墨灵中转站（molingapi）”，并让 AiOnline 通过稳定 API 消费它。

**Architecture:** molingapi 分为管理面和数据面。管理面只负责 provider/key/model/binding/routing 配置；数据面负责模型解析、密钥池调度、限流、熔断、任务状态、SSE 和结果回传。第一期不迁移 AiOnline 的用户余额、支付、素材库和 OSS 账务，避免两个系统重复扣款；AiOnline 继续作为用户身份、余额和媒体资产的权威系统，通过内部服务令牌调用 molingapi。

**Tech Stack:** 复用 AiOnline 已验证的 React 19 + Vite + TypeScript 管理台；Node.js CommonJS API；PostgreSQL 17；Redis 7.2；现有 provider adapter、dispatcher、SSE 和 `node:test`/Vitest 测试体系。

## Global Constraints

- 对外模型身份统一使用 canonical `modelId`；`displayName`/`mappingName` 只用于兼容和展示。
- 浏览器永远不直连上游服务商；API Key 只进入 molingapi 服务端，并且数据库和响应都不得暴露明文。
- 每次生成必须支持 `idempotencyKey`，任务状态只允许单向进入 `done`、`failed` 或 `canceled` 终态。
- 模型参数以 `paramTemplate` 为唯一能力声明来源；前端不得为某个具体模型硬编码参数。
- 第一阶段不迁移支付、充值、用户余额、素材库、角色、参考样式和 OSS 配置；这些仍由 AiOnline 管理。
- 第一阶段保留 `/api/*` 兼容适配层，同时提供版本化 `/v1/*` API；完成双写/灰度验收后才移除旧直连逻辑。
- 管理写操作必须使用管理员权限和 `revision` 乐观锁；冲突返回 HTTP 409，并禁止静默覆盖。

---

## 目标边界和现状证据

当前 AiOnline 已经具备可抽取的 Model Hub 领域代码：

- `src/pages/ModelHubPage/ModelHubPage.tsx` 已有“模型列表、服务商、自定义协议、配套关系、存储配置”管理入口。
- `src/hooks/useModelHub.ts` 已实现 `/api/providers`、`/api/models` 的加载、增量 PATCH、删除和 revision 对账。
- `src/data/models.ts` 已定义 `IModelProvider`、`IAiModel`、`IModelParamTemplate`、`IEndpoint` 和 `IModelEndpoint`。
- `server/modules/modelhub/resolver.cjs`、`bindings.cjs`、`router.cjs`、`jobs.cjs` 和 `revision.cjs` 已覆盖模型归一、线路绑定、路由评分、作业记录和乐观锁。
- `server/dispatcher.cjs` 已覆盖多 Key、RPM/桶限速、并发、熔断、等待区和生成任务调度；`server/providers/video/*` 已有视频适配器。
- `src/components/GenerationBar.tsx` 在 1098 行附近以 `modelId`、参数模板和 `idempotencyKey` 提交异步任务，并消费 task status/SSE。
- `server/server.js` 已提供 `/api/providers`、`/api/models`、`/api/generate`、`/api/generate/status/:taskId`、`/api/generate/stream`、`/api/generate/cancel/:taskId` 及管理路由。

线上 `/model-hub` 会跳转登录页，因此功能验收以源码和登录后的真实环境为准，不把公开页面当作 API 契约。

## 目标目录

新仓库 `molingapi` 从 AiOnline 迁移时使用以下边界；迁移期间不修改 AiOnline 的工作台源文件：

```text
molingapi/
  server/
    server.js
    db.cjs
    auth.cjs
    realtime.cjs
    modules/modelhub/{resolver,bindings,router,jobs,revision}.cjs
    providers/video/{index,shared,agnes,minimax,volcano}.cjs
    relay/{contracts,providerClient,taskService,routeService}.cjs
  src/
    pages/ModelHubPage/
    components/ModelParamTemplateEditor.tsx
    hooks/useModelHub.ts
    services/api.ts
    data/models.ts
    data/settings.ts
    utils/groupModels.ts
  shared/model-relay-contracts.ts
  scripts/seed-model-hub.cjs
  migrations/
  docs/
```

明确不复制 `src/pages/WorkspacePage`、`src/pages/LibraryPage`、`src/pages/CharactersPage`、`src/data/media.ts`、`server/oss.cjs`、支付/商城/市集和工作台布局；这些属于 AiOnline 消费侧。

---

### Task 1: 冻结源代码清单和迁移边界

**Files:**
- Create: `docs/architecture/model-relay-boundary.md`
- Create: `docs/architecture/source-inventory.md`
- Test: `scripts/verify-model-relay-source.ps1`

**Interfaces:**
- Consumes: AiOnline 当前 `src/pages/ModelHubPage`、`src/hooks/useModelHub.ts`、`src/data/models.ts`、`server/modules/modelhub` 和 `server/dispatcher.cjs`。
- Produces: 一份可审计的迁移清单，以及能在源仓库中检查关键文件仍存在的脚本。

- [ ] **Step 1: 写源代码清单**

  在 `source-inventory.md` 中逐项记录保留文件、复制文件、适配文件和明确排除文件，并把以下函数作为迁移入口：`resolveModelIdentity`、`loadDispatchPairs`、`routeBindings`、`createJob`、`optimisticUpdate`、`dispatcher.generateAsync`、`dispatcher.getTaskStatus`。

- [ ] **Step 2: 写边界决策**

  在 `model-relay-boundary.md` 中固定“molingapi 管 provider/model/routing/task，AiOnline 管 user/credits/media/OSS/payment”的责任矩阵，并说明第一期结果 URL 由 AiOnline 的现有媒体流程继续落库。

- [ ] **Step 3: 写可重复的清单检查**

  `scripts/verify-model-relay-source.ps1` 检查以下路径存在，并在任一文件缺失时以非零状态退出：

  ```powershell
  $required = @(
    'src/pages/ModelHubPage/ModelHubPage.tsx',
    'src/hooks/useModelHub.ts',
    'src/data/models.ts',
    'server/modules/modelhub/resolver.cjs',
    'server/modules/modelhub/bindings.cjs',
    'server/modules/modelhub/router.cjs',
    'server/modules/modelhub/jobs.cjs',
    'server/dispatcher.cjs'
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) { throw "missing source: $path" }
  }
  Write-Output 'model relay source inventory: PASS'
  ```

- [ ] **Step 4: Run the source check**

  Run: `pwsh -File scripts/verify-model-relay-source.ps1`

  Expected: `model relay source inventory: PASS`。

- [ ] **Step 5: Commit**

  ```bash
  git add docs/architecture scripts/verify-model-relay-source.ps1
  git commit -m "docs: freeze model relay extraction boundary"
  ```

### Task 2: 提取共享模型和 API 契约

**Files:**
- Create: `shared/model-relay-contracts.ts`
- Create: `shared/model-relay-contracts.test.ts`
- Modify: `src/data/models.ts`
- Modify: `src/services/api.ts`

**Interfaces:**
- Consumes: 现有 `IModelProvider`、`IAiModel`、`IModelParamTemplate`、`IEndpoint` 和 `apiGenerate` payload。
- Produces: API 和管理台共享的稳定类型 `ModelType`、`ProviderSummary`、`ModelSummary`、`GenerateRequest`、`GenerateAccepted`、`TaskStatus`。

- [ ] **Step 1: 写失败的契约测试**

  ```ts
  import { describe, expect, it } from 'vitest';
  import { isTerminalTaskStatus, normalizeModelId } from './model-relay-contracts';

  describe('model relay contracts', () => {
    it('uses canonical modelId before display aliases', () => {
      expect(normalizeModelId({ modelId: 'flux-1', model: 'Flux 1' })).toBe('flux-1');
      expect(normalizeModelId({ model: '', model: 'Flux 1' })).toBe('Flux 1');
    });

    it('recognizes only the three terminal task states', () => {
      expect(isTerminalTaskStatus('done')).toBe(true);
      expect(isTerminalTaskStatus('failed')).toBe(true);
      expect(isTerminalTaskStatus('canceled')).toBe(true);
      expect(isTerminalTaskStatus('running')).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npm exec vitest run shared/model-relay-contracts.test.ts`

  Expected: FAIL because `shared/model-relay-contracts.ts` does not exist。

- [ ] **Step 3: 实现共享契约**

  至少实现以下类型和函数，所有字段名使用 camelCase：

  ```ts
  export type ModelType = 'image' | 'video' | 'text';
  export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'canceled';

  export interface ProviderSummary {
    id: string;
    name: string;
    baseUrl: string;
    protocol: 'openai-compatible' | 'custom';
    supportedTypes: ModelType[];
    enabled: boolean;
    keyCount: number;
  }

  export interface ModelSummary {
    id: string;
    modelId: string;
    displayName: string;
    mappingName?: string;
    type: ModelType;
    enabled: boolean;
    providerIds: string[];
    capabilities: Record<string, boolean>;
    paramTemplate: Record<string, unknown>;
    sortOrder: number;
  }

  export interface GenerateRequest {
    modelId: string;
    model?: string;
    prompt: string;
    ratio?: string;
    resolution?: string;
    quality?: 'low' | 'standard' | 'high';
    count?: number;
    contentType: ModelType;
    referenceImages?: string[];
    negative?: string;
    duration?: number;
    videoMode?: string;
    idempotencyKey: string;
  }

  export interface GenerateAccepted {
    status: 'pending';
    taskId: string;
    modelId: string;
  }

  export interface TaskSnapshot {
    taskId: string;
    state: TaskStatus;
    result?: { images?: string[]; videoUrl?: string; text?: string };
    error?: string;
  }

  export function normalizeModelId(input: Pick<GenerateRequest, 'modelId' | 'model'>): string {
    return input.modelId.trim() || (input.model || '').trim();
  }

  export function isTerminalTaskStatus(status: TaskStatus): boolean {
    return status === 'done' || status === 'failed' || status === 'canceled';
  }
  ```

  任务快照接口命名为 `TaskSnapshot`，状态字段使用 `state: TaskStatus`，避免类型名和属性名冲突。

- [ ] **Step 4: 让现有前端使用共享类型**

  在 `src/data/models.ts` 中保留向后兼容的导出，在 `src/services/api.ts` 中把 `apiGenerate`、`apiGetGenerationStatus`、`apiListActiveGenerations` 的返回类型映射到共享契约；不得改变旧 `/api/*` URL。

- [ ] **Step 5: Run the test**

  Run: `npm exec vitest run shared/model-relay-contracts.test.ts src/__tests__/data/models.test.ts`

  Expected: PASS。

- [ ] **Step 6: Commit**

  ```bash
  git add shared src/data/models.ts src/services/api.ts
  git commit -m "feat: define shared model relay contracts"
  ```

### Task 3: 建立 molingapi 数据库和密钥安全边界

**Files:**
- Create: `migrations/001_model_relay.sql`
- Create: `server/relay/secrets.cjs`
- Create: `server/relay/secrets.test.cjs`
- Modify: `server/db.cjs`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: 现有 `providers`、`models`、`api_keys`、`provider_model_bindings`、`generation_tasks`、`generation_jobs` 和 `generation_attempts` 结构。
- Produces: provider/model/key/binding/task/attempt 的独立 schema；`encryptSecret`、`decryptSecret`、`maskSecret` 三个服务端函数。

- [ ] **Step 1: 写密钥测试**

  ```js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { encryptSecret, decryptSecret, maskSecret } = require('./secrets.cjs');

  test('encrypts provider keys without storing plaintext', () => {
    const sealed = encryptSecret('sk-provider-test');
    assert.notEqual(sealed, 'sk-provider-test');
    assert.equal(decryptSecret(sealed), 'sk-provider-test');
    assert.equal(maskSecret('sk-provider-test'), '***test');
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test server/relay/secrets.test.cjs`

  Expected: FAIL because `server/relay/secrets.cjs` does not exist。

- [ ] **Step 3: 实现 AES-256-GCM 密钥封装**

  `MODEL_RELAY_MASTER_KEY` 必须是 64 个 hex 字符；缺失、长度不正确或解密失败时直接抛错。密文格式固定为 `v1:<iv hex>:<auth tag hex>:<ciphertext hex>`。`maskSecret` 只返回最后四个字符，长度不足四个字符时返回 `***`。

- [ ] **Step 4: 写数据库迁移**

  `001_model_relay.sql` 创建并加索引：

  - `providers`：`id`、`name`、`base_url`、`protocol`、`enabled`、`capacity_model`、`rate_limits`、`revision`。
  - `provider_keys`：`id`、`provider_id`、`secret_ciphertext`、`label`、`status`、`weight`、失败计数和最后使用时间；唯一约束为 `(provider_id, secret_ciphertext)`。
  - `models`：`model_id`、`display_name`、`mapping_name`、`type`、`enabled`、`capabilities`、`param_template`、`credit_cost`、`sort_order`、`revision`。
  - `provider_model_bindings`：`model_id`、`provider_id`、`enabled`、端点覆盖和 `revision`；唯一约束为 `(model_id, provider_id)`。
  - `generation_tasks`：`task_id`、`idempotency_key`、`user_id`、`model_id`、`state`、`request_json`、`result_json`、`error`、时间戳；唯一约束为 `(user_id, idempotency_key)`。
  - `generation_jobs` 和 `generation_attempts`：记录每条线路的选择原因、provider/key、开始/结束时间、状态、HTTP 状态和错误分类。

  所有 provider key 查询只返回 `id`、`label`、`status`、`masked`、失败计数和时间戳；任何 SQL 查询不得把 `secret_ciphertext` 直接序列化到 HTTP 响应。

- [ ] **Step 5: 配置本地依赖**

  在 `.env.example` 增加 `MODEL_RELAY_MASTER_KEY`、`MODEL_RELAY_INTERNAL_TOKEN`、`MODEL_RELAY_PUBLIC_BASE_URL`；Compose 保留 PostgreSQL 17 和 Redis 7.2，并为新服务加入健康检查。

- [ ] **Step 6: Run verification**

  Run: `node --test server/relay/secrets.test.cjs`

  Expected: PASS；使用无效主密钥时测试应确认进程 fail-closed。

- [ ] **Step 7: Commit**

  ```bash
  git add migrations server/relay/secrets.cjs server/relay/secrets.test.cjs server/db.cjs .env.example docker-compose.yml
  git commit -m "feat: add model relay schema and secret boundary"
  ```

### Task 4: 抽出数据面路由和异步任务服务

**Files:**
- Create: `server/relay/providerClient.cjs`
- Create: `server/relay/taskService.cjs`
- Create: `server/relay/routeService.cjs`
- Create: `server/relay/httpRoutes.cjs`
- Create: `server/relay/providerClient.test.cjs`
- Create: `server/relay/taskService.test.cjs`
- Copy and adapt: `server/modules/modelhub/*.cjs`
- Copy and adapt: `server/providers/video/*.cjs`
- Copy and adapt: `server/dispatcher.cjs`
- Modify: `server/server.js`

**Interfaces:**
- Consumes: `resolveModelIdentity`、`loadDispatchPairs`、`routeBindings`、`generateAsync`、`getTaskStatus`、`listActiveTasks` 和视频适配器。
- Produces: `POST /v1/generations`、`GET /v1/models`、`GET /v1/tasks/:taskId`、`GET /v1/tasks/:taskId/events`、`POST /v1/tasks/:taskId/cancel`；内部兼容 `/api/generate*`。

- [ ] **Step 1: 写 provider client 失败测试**

  测试使用假的 `fetch`，验证 openai-compatible 图片请求把 `model`、`prompt`、`n`、`size` 放入请求体，Authorization 只在服务端注入；非 2xx 响应必须携带可分类的 `provider_http_error`。

- [ ] **Step 2: 写 task service 失败测试**

  测试以下不可变规则：相同 `(userId, idempotencyKey)` 返回同一 `taskId`；`done` 不得回退到 `running`；owner 之外的取消请求返回 403；终态取消返回 409；取消只释放一次上游资源。

- [ ] **Step 3: Run tests to verify they fail**

  Run: `node --test server/relay/providerClient.test.cjs server/relay/taskService.test.cjs`

  Expected: FAIL because the relay services do not exist。

- [ ] **Step 4: 实现 provider client**

  定义统一调用入口：

  ```js
  async function submitProviderJob({ provider, model, apiKey, request, signal }) {
    // returns { kind: 'sync', images, videoUrl, text } or
    // { kind: 'async', providerTaskId, poll }
  }
  ```

  `openai-compatible` 使用统一请求格式；`custom` 使用现有 `IEndpoint` 的 body/path 字段模板；视频 submit/poll 复用 `server/providers/video/shared.cjs`。provider 原始错误只写内部 attempt 日志，返回给调用方的是稳定错误码和脱敏消息。

- [ ] **Step 5: 实现 route service**

  先调用 resolver 得到 canonical model IDs，再由 bindings 过滤 enabled provider、enabled binding 和 active key，最后调用现有 router 的门控顺序：手动 cold、熔断、并发、桶限速、模型能力、评分/权重。每次选择都写入 `generation_jobs` 和 `generation_attempts`，并保留 chosen/rejected 原因供管理台解释。

- [ ] **Step 6: 实现 task service 和 SSE**

  任务流程固定为：`queued -> running -> waiting -> running -> done|failed|canceled`。提交时先用数据库唯一约束实现幂等，再入 Redis/内存等待泵；任务终态同时写 PostgreSQL 和 `realtime.cjs`。SSE 只推送当前用户的任务，不允许通过猜测 taskId 读取他人任务。

- [ ] **Step 7: 挂载版本化和兼容路由**

  `httpRoutes.cjs` 只处理 JSON、鉴权、参数校验和状态码；业务逻辑不得继续堆入 `server/server.js`。新旧路由映射如下：

  ```text
  GET  /v1/models                         -> enabled logical models
  POST /v1/generations                    -> { status: 'pending', taskId }
  GET  /v1/tasks/:taskId                  -> task snapshot
  GET  /v1/tasks/:taskId/events           -> user-scoped SSE
  POST /v1/tasks/:taskId/cancel           -> cancel + idempotent release
  GET  /api/providers                     -> admin provider summaries
  PATCH /api/providers/:id                -> admin provider patch + revision
  GET  /api/models                        -> admin model rows
  PATCH /api/models/:id                   -> admin model patch + revision
  POST /api/generate                      -> adapter to POST /v1/generations
  ```

- [ ] **Step 8: Run server tests**

  Run: `node --test server/modules/modelhub/*.test.cjs server/relay/*.test.cjs`

  Expected: PASS；至少覆盖模型别名解析、重复绑定去重、权重选择、熔断恢复、密钥池隔离、限速、重复提交、SSE owner 校验和取消幂等。

- [ ] **Step 9: Commit**

  ```bash
  git add server
  git commit -m "feat: extract model relay data plane"
  ```

### Task 5: 搭建独立 Model Hub 管理台

**Files:**
- Create: `src/pages/ModelHubPage/ModelHubApp.tsx`
- Create: `src/pages/ModelHubPage/ModelHubApp.test.tsx`
- Copy and adapt: `src/pages/ModelHubPage/ModelHubPage.tsx`
- Copy and adapt: `src/pages/ModelHubPage/ProviderModelsPanel.tsx`
- Copy and adapt: `src/pages/ModelHubPage/EndpointsTab.tsx`
- Copy and adapt: `src/pages/ModelHubPage/PairingTab.tsx`
- Copy and adapt: `src/pages/ModelHubPage/AddModelDialog.tsx`
- Copy and adapt: `src/pages/ModelHubPage/AsyncAddDialog.tsx`
- Copy and adapt: `src/components/ModelParamTemplateEditor.tsx`
- Copy and adapt: `src/hooks/useModelHub.ts`

**Interfaces:**
- Consumes: `/api/providers`、`/api/providers/:id/keys`、`/api/providers/states`、`/api/models`、`/api/models/:id`、`/api/admin/routing/decide`。
- Produces: 管理员可以安全配置 provider、密钥池、模型、模型模板、绑定关系、容量限制和路由解释；前台只看到脱敏 key。

- [ ] **Step 1: 写管理台渲染测试**

  使用 Testing Library 验证：模型列表按 `model_id` 聚合；禁用模型不出现在可用列表；provider key 只显示 `masked`；revision 冲突显示刷新提示；模型模板编辑能保存 `paramTemplate`。

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm exec vitest run src/pages/ModelHubPage/ModelHubApp.test.tsx`

  Expected: FAIL because `ModelHubApp` does not exist。

- [ ] **Step 3: 抽取 UI 依赖**

  只复制管理台所需的 UI primitives、`data/models.ts`、`utils/groupModels.ts`、鉴权守卫和 API client；不要把工作台图库、素材卡片、OSS 配置或商城路由带入 molingapi。

- [ ] **Step 4: 接入真实 CRUD**

  让 provider/model 写操作统一走 REST 单条 POST/PATCH/DELETE；禁止旧的“全量列表覆盖”保存。新增 key 只能走专用 POST，编辑 provider 时输入框为空表示不修改已有 key。

- [ ] **Step 5: 接入路由观测**

  增加 provider/key 冷热状态、等待区、最近任务、线路 attempt 和 `/api/admin/routing/decide` 的只读视图；观测失败不阻塞 CRUD，但必须在页面显示 stale 状态。

- [ ] **Step 6: Run frontend checks**

  Run: `npm run typecheck; npm exec vitest run src/pages/ModelHubPage/ModelHubApp.test.tsx`

  Expected: PASS。

- [ ] **Step 7: Commit**

  ```bash
  git add src
  git commit -m "feat: add standalone model hub console"
  ```

### Task 6: 让 AiOnline 通过 molingapi 消费

**Files:**
- Create in AiOnline: `server/relayClient.cjs`
- Create in AiOnline: `server/relayClient.test.cjs`
- Modify in AiOnline: `server/server.js`
- Modify in AiOnline: `src/services/api.ts`
- Modify in AiOnline: `src/hooks/useModelHub.ts`
- Modify in AiOnline: `src/components/GenerationBar.tsx`
- Modify in AiOnline: `.env.example`

**Interfaces:**
- Consumes: molingapi `/v1/models`、`/v1/generations`、`/v1/tasks/*`、SSE 和 `MODEL_RELAY_INTERNAL_TOKEN`。
- Produces: AiOnline 的用户登录、余额、媒体落库和 OSS 逻辑保持原有归属；provider/model/routing 不再直接查询本地表或持有上游 key。

- [ ] **Step 1: 写转发客户端失败测试**

  验证 AiOnline 只向 molingapi 发送 `modelId`、prompt、生成参数、`idempotencyKey` 和已授权的内部 user context；验证上游 API Key 不出现在请求日志、前端 bundle 和浏览器网络请求中。

- [ ] **Step 2: Run test to verify it fails**

  Run: `node --test server/relayClient.test.cjs`

  Expected: FAIL because `server/relayClient.cjs` does not exist。

- [ ] **Step 3: 实现服务端转发**

  `relayClient.cjs` 使用 `MODEL_RELAY_BASE_URL` 和 `MODEL_RELAY_INTERNAL_TOKEN`，设置 10 秒连接超时、请求级 AbortSignal 和有限重试；只有网络错误或 502/503 可重试，400/401/402/409 不重试。转发结果仍由 AiOnline 现有 media/OSS 流程处理。

- [ ] **Step 4: 切换模型目录读取**

  `useModelHub.ts` 改为读取 molingapi 的逻辑模型目录；`GenerationBar.tsx` 保持当前 `modelId` 优先行为和参数模板校正；删除前端读取 provider 明文 key 的路径。

- [ ] **Step 5: 切换生成任务通道**

  `src/services/api.ts` 保留旧函数签名作为兼容层，但其实现请求 AiOnline 的 BFF；BFF 再调用 molingapi。status/SSE/cancel 由 BFF 做 user ownership 检查后转发，避免浏览器直接接触内部令牌。

- [ ] **Step 6: 保持计费单一归属**

  AiOnline 在向 molingapi 发起任务前后继续使用原有 reserve/commit/release 账务；molingapi 只记录 `userId`、`billingReference` 和 provider cost 观测数据，不执行第二次扣费。失败、取消、超时的转发测试必须证明余额只发生一次 reserve 和一次 commit/release。

- [ ] **Step 7: Run integration checks**

  Run: `npm run typecheck; npm test; node --test server/relayClient.test.cjs`

  Expected: PASS；浏览器 Network 中只出现 AiOnline `/api/*`，服务端日志只出现脱敏 provider/key 信息。

- [ ] **Step 8: Commit**

  ```bash
  git add server src .env.example
  git commit -m "feat: route AiOnline generation through molingapi"
  ```

### Task 7: 部署、迁移和切换验收

**Files:**
- Create: `docs/deployment.md`
- Create: `docs/migration-runbook.md`
- Create: `scripts/export-model-hub.cjs`
- Create: `scripts/import-model-hub.cjs`
- Create: `scripts/smoke-model-relay.mjs`
- Modify: `docker-compose.prod.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: AiOnline 当前 `providers`、`models`、`api_keys`、`provider_model_bindings` 和模型种子配置。
- Produces: 可回滚的导出/导入、健康检查、冒烟测试和灰度切换文档。

- [ ] **Step 1: 实现脱敏导出**

  `export-model-hub.cjs` 导出 provider 元数据、模型、模板、绑定、限速和排序；不导出明文 key。密钥迁移通过一次性受保护输入或服务端密钥重封装完成，导出的 JSON 中只允许出现 `masked` 字段。

- [ ] **Step 2: 实现幂等导入**

  `import-model-hub.cjs` 以 `id` 和 `(model_id, provider_id)` 作为幂等键，使用事务和 revision 初始化；重复导入不重复创建 provider/model/binding。

- [ ] **Step 3: 写冒烟测试**

  `smoke-model-relay.mjs` 按顺序检查 `/api/healthz`、`/v1/models`、管理员读取、内部生成提交、task status、SSE 终态和 cancel。测试请求使用测试 provider，不连接真实收费模型。

- [ ] **Step 4: 写切换顺序**

  固定为：导出 -> 导入 -> provider 连接测试 -> 单模型生成 -> 任务/SSE/cancel -> AiOnline 灰度用户 -> 全量切换 -> 观察 24 小时 -> 删除旧 provider 直连。任一步失败都把 `MODEL_RELAY_ENABLED=false`，回退到 AiOnline 原路径；不得回退数据库数据。

- [ ] **Step 5: Run final verification**

  Run: `npm run lint; npm run build; npm test; node scripts/smoke-model-relay.mjs`

  Expected: 全部 PASS；健康检查显示 PostgreSQL/Redis 正常；测试日志中没有 `api_key`、`secret_ciphertext` 或 `MODEL_RELAY_INTERNAL_TOKEN` 的明文。

- [ ] **Step 6: Commit**

  ```bash
  git add docs scripts docker-compose.prod.yml README.md
  git commit -m "docs: add molingapi migration and deployment runbook"
  ```

## 验收标准

1. molingapi 可以单独启动，管理员可以创建/编辑/禁用 provider、密钥、模型和绑定；刷新或多管理员并发编辑不会丢数据。
2. `GET /v1/models` 只返回 enabled 且至少有一条可用线路的逻辑模型，并保留 canonical `modelId`。
3. 同一用户以同一 `idempotencyKey` 重复提交只产生一个任务、一次上游调用和一次账务引用。
4. 多 Key、限速、并发、熔断、等待区、异步视频轮询、SSE、取消和超时都有自动化测试。
5. AiOnline 的浏览器请求看不到 provider base URL、API Key 和内部令牌；现有工作台仍可选择模型、提交生成、查看结果和取消任务。
6. 第一阶段不存在双重扣费：余额账务仍只发生在 AiOnline；molingapi 的成本字段只用于路由和观测。
7. 部署失败可通过 `MODEL_RELAY_ENABLED=false` 回滚，且不删除 AiOnline 原数据库表和配置。

## 实施前提

当前工作区原始目录只有未提交的 4 个前端文件，完整可运行源码已经从用户提供的 `https://github.com/marinerfan123/AiOnline` 克隆到 `AiOnline/`。后续实施应以该完整仓库为源，先创建独立 molingapi 仓库，再按本计划执行；不要把当前外层目录中的临时 `src/` 文件当作完整基线。
