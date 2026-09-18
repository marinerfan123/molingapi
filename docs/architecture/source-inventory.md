# Model Relay Source Inventory

## Scope

This inventory freezes the Task 1 extraction boundary between the existing
`AiOnline/` source tree and the target `molingapi/` repository. It is based on
the current source layout and the migration plan. The inventory records paths,
interfaces, and ownership only; it does not include secret values, credentials,
or tokens.

`AiOnline/` remains the source of truth during extraction. The outer workspace
`src/` directory is not a complete baseline and is not part of this inventory.

## Migration Actions

The action terms have precise meanings:

- **Retain**: keep the file in `AiOnline`; it remains part of the consumer
  system and is not copied into `molingapi`.
- **Copy**: use the file as the initial extraction baseline in `molingapi`.
- **Adapt**: copy only the relevant behavior, then change imports, storage,
  authentication, and HTTP boundaries before production use.
- **Exclude**: do not copy the file; it belongs to the AiOnline consumer side
  or is outside the Task 1 extraction scope.

Retain and exclude are intentionally paired for consumer-owned files: those
files stay in AiOnline and are excluded from the molingapi target snapshot.

### Retain in AiOnline

These files remain authoritative for users, credits, media, OSS, and payment:

| Source path | Reason to retain |
| --- | --- |
| `AiOnline/src/services/authStore.ts` | Browser session and user identity state. |
| `AiOnline/src/pages/Auth/AuthPage.tsx` | User login and registration UI. |
| `AiOnline/src/data/media.ts` | Consumer media record shape and media ownership. |
| `AiOnline/src/pages/WorkspacePage/WorkspacePage.tsx` | Workspace result display and media persistence flow. |
| `AiOnline/src/pages/LibraryPage/LibraryPage.tsx` | User media library and deletion flow. |
| `AiOnline/src/pages/CharactersPage/CharactersPage.tsx` | User characters and reference media. |
| `AiOnline/src/data/oss.ts` | AiOnline OSS configuration and client-side model. |
| `AiOnline/src/hooks/useOssConfig.ts` | AiOnline upload and ingest workflow. |
| `AiOnline/src/components/OssConfigPanel.tsx` | AiOnline OSS administration UI. |
| `AiOnline/server/oss.cjs` | OSS signing, namespace checks, and ingest operations. |
| `AiOnline/server/assetFinalize.cjs` | Finalizing provider results into AiOnline media assets. |
| `AiOnline/server/uploadQueue.cjs` | AiOnline media upload worker. |
| `AiOnline/server/billing.cjs` | Credit reserve, commit, and release authority. |
| `AiOnline/server/accounting.cjs` | User credit ledger and accounting helpers. |
| `AiOnline/server/payments.cjs` | Recharge orders and payment lifecycle. |
| `AiOnline/server/payments/` | Payment provider and webhook implementation. |
| `AiOnline/src/pages/RechargePage/RechargePage.tsx` | User credit and recharge UI. |
| `AiOnline/src/pages/Shop/` | Shop, marketplace, and payment-adjacent consumer UI. |

`AiOnline/server/auth.cjs` also remains the authority for AiOnline user
sessions. A future `molingapi/server/auth.cjs` may adapt only the management
and internal-caller checks; it must not become a second user-account authority.

### Copy as the extraction baseline

These files contain the existing provider/model/routing behavior that the
target service needs to start from:

| Source path | Extraction role | Target path |
| --- | --- | --- |
| `AiOnline/server/modules/modelhub/resolver.cjs` | Canonical model identity resolution. | `molingapi/server/modules/modelhub/resolver.cjs` |
| `AiOnline/server/modules/modelhub/bindings.cjs` | Enabled model/provider binding lookup. | `molingapi/server/modules/modelhub/bindings.cjs` |
| `AiOnline/server/modules/modelhub/router.cjs` | Routing gates, scoring, and ordering. | `molingapi/server/modules/modelhub/router.cjs` |
| `AiOnline/server/modules/modelhub/jobs.cjs` | Per-route job and attempt records. | `molingapi/server/modules/modelhub/jobs.cjs` |
| `AiOnline/server/modules/modelhub/revision.cjs` | Revision-checked management writes. | `molingapi/server/modules/modelhub/revision.cjs` |
| `AiOnline/server/providers/video/index.cjs` | Video provider adapter selection. | `molingapi/server/providers/video/index.cjs` |
| `AiOnline/server/providers/video/shared.cjs` | Shared submit/poll behavior. | `molingapi/server/providers/video/shared.cjs` |
| `AiOnline/server/providers/video/agnes.cjs` | Agnes adapter. | `molingapi/server/providers/video/agnes.cjs` |
| `AiOnline/server/providers/video/minimax.cjs` | MiniMax adapter. | `molingapi/server/providers/video/minimax.cjs` |
| `AiOnline/server/providers/video/volcano.cjs` | Volcano adapter. | `molingapi/server/providers/video/volcano.cjs` |
| `AiOnline/src/utils/groupModels.ts` | Model/provider grouping used by Model Hub. | `molingapi/src/utils/groupModels.ts` |
| `AiOnline/scripts/seed-model-hub.cjs` | Model Hub seed workflow. | `molingapi/scripts/seed-model-hub.cjs` |

The copied files are an implementation baseline, not a license to carry over
consumer ownership. Their imports and side effects must pass the boundary
checks in the next phase.

### Adapt for molingapi

These files are coupled to both sides or to the existing monolith and must be
adapted before they are used in the target service:

| Source path | Required adaptation |
| --- | --- |
| `AiOnline/server/dispatcher.cjs` | Extract model resolution, key-pool scheduling, route selection, provider calls, and task state; remove direct user-credit, media, and OSS ownership. |
| `AiOnline/server/server.js` | Split the monolith into `/v1/*` relay routes, admin Model Hub routes, and the `/api/*` compatibility adapter; do not bring over media, OSS, payment, or consumer routes. |
| `AiOnline/server/db.cjs` | Create molingapi-owned provider, key, model, binding, task, job, and attempt schema; do not copy AiOnline user, media, OSS, or payment tables as authorities. |
| `AiOnline/server/auth.cjs` | Keep only the identity claims needed to authorize management and internal calls; user identity is still issued and owned by AiOnline. |
| `AiOnline/server/realtime.cjs` | Adapt task event delivery to user-scoped relay task events without becoming a user or media event bus. |
| `AiOnline/src/pages/ModelHubPage/ModelHubPage.tsx` | Replace the AiOnline page shell and consumer assumptions with an independent Model Hub management app. |
| `AiOnline/src/pages/ModelHubPage/ProviderModelsPanel.tsx` | Point provider/model editing at molingapi management routes and masked key summaries. |
| `AiOnline/src/pages/ModelHubPage/EndpointsTab.tsx` | Keep endpoint templates but make provider endpoint data belong to molingapi. |
| `AiOnline/src/pages/ModelHubPage/PairingTab.tsx` | Read and write provider/model bindings through molingapi. |
| `AiOnline/src/pages/ModelHubPage/AddModelDialog.tsx` | Use canonical `modelId` and molingapi model creation responses. |
| `AiOnline/src/pages/ModelHubPage/AsyncAddDialog.tsx` | Keep model discovery behavior but route provider probing through molingapi. |
| `AiOnline/src/components/ModelParamTemplateEditor.tsx` | Keep `paramTemplate` editing while removing consumer-only assumptions. |
| `AiOnline/src/hooks/useModelHub.ts` | Change the API base and response mapping; preserve revision conflict handling. |
| `AiOnline/src/services/api.ts` | Add stable relay contracts and `/v1/*` calls while preserving the legacy adapter surface during migration. |
| `AiOnline/src/data/models.ts` | Split shared provider/model contracts from consumer display and credit fields. |
| `AiOnline/src/data/settings.ts` | Retain only settings needed by the Model Hub app; do not move user/workspace settings. |

### Exclude from molingapi

The following files and directories are explicitly not part of the extracted
service:

| Source path | Exclusion reason |
| --- | --- |
| `AiOnline/src/pages/WorkspacePage/` | AiOnline workbench and result consumption. |
| `AiOnline/src/pages/LibraryPage/` | User media library. |
| `AiOnline/src/pages/CharactersPage/` | User characters and reference assets. |
| `AiOnline/src/features/canvas/` | Workbench layout and canvas state. |
| `AiOnline/src/components/Layout.tsx` | Consumer application shell. |
| `AiOnline/src/components/layouts/StudioLayout.tsx` | Consumer studio layout. |
| `AiOnline/src/components/layouts/ShopLayout.tsx` | Shop and marketplace layout. |
| `AiOnline/src/data/media.ts` | Media records remain AiOnline-owned. |
| `AiOnline/src/data/oss.ts` | OSS configuration remains AiOnline-owned. |
| `AiOnline/src/hooks/useOssConfig.ts` | OSS upload/ingest remains AiOnline-owned. |
| `AiOnline/server/oss.cjs` | OSS credentials, signing, and object ownership remain AiOnline-owned. |
| `AiOnline/server/assetFinalize.cjs` | AiOnline media finalization. |
| `AiOnline/server/uploadQueue.cjs` | AiOnline media upload worker. |
| `AiOnline/server/billing.cjs` | No duplicate credit ledger or second debit path. |
| `AiOnline/server/accounting.cjs` | User accounting remains in AiOnline. |
| `AiOnline/server/payments.cjs` and `AiOnline/server/payments/` | Recharge and payment providers remain in AiOnline. |
| `AiOnline/src/pages/RechargePage/` | Credit purchase UI. |
| `AiOnline/src/pages/Shop/` | Shop, marketplace, and payment UI. |

The exclusion list is about ownership, not about the result handoff: a
successful relay may return result metadata to AiOnline, and AiOnline's
existing media flow continues to persist the user-visible asset and its URL.

## Migration Entry Points

| Entry point | Current source location | Boundary meaning |
| --- | --- | --- |
| `resolveModelIdentity` | `AiOnline/server/modules/modelhub/resolver.cjs:25` | Normalize canonical model IDs before routing. |
| `loadDispatchPairs` | `AiOnline/server/modules/modelhub/bindings.cjs:28` | Load enabled model/provider routes and active capacity inputs. |
| `routeBindings` | `AiOnline/server/modules/modelhub/router.cjs:255` | Apply routing gates, scoring, and deterministic ordering. |
| `createJob` | `AiOnline/server/modules/modelhub/jobs.cjs:41` | Record a selected provider/model route and its attempt metadata. |
| `optimisticUpdate` | `AiOnline/server/modules/modelhub/revision.cjs:36` | Protect management writes with revision comparison. |
| `dispatcher.generateAsync` | `AiOnline/server/dispatcher.cjs:1098` | Create and run an asynchronous generation task. |
| `dispatcher.getTaskStatus` | `AiOnline/server/dispatcher.cjs:1588` | Read a task snapshot for the owning caller. |
| `dispatcher.listActiveTasks` | `AiOnline/server/dispatcher.cjs:1619` | Restore in-flight tasks after a client refresh. |

The front-end contract evidence is `AiOnline/src/components/GenerationBar.tsx`
around the asynchronous submission block: it sends canonical `modelId`, an
optional display alias, the parameter payload, and an `idempotencyKey`. The
corresponding legacy API surface is in `AiOnline/src/services/api.ts`:
`/api/generate`, task status, active-task recovery, SSE, and cancel routes.

## Non-Negotiable Extraction Rules

1. `modelId` is the canonical model identity. `displayName` and `mappingName`
   are compatibility/display fields only.
2. Provider credentials enter and remain in molingapi server-side code; source
   inventory, database responses, logs, and browser payloads must expose only
   masked metadata.
3. The relay owns provider, key pool, model, routing, and task behavior.
4. AiOnline owns user, credits, media, OSS, and payment behavior.
5. A relay result is handed back to AiOnline's existing media finalization
   flow; molingapi does not create a second media or credit authority.
6. No runtime file outside the three Task 1 deliverables is modified by this
   task.
