# Model Relay Boundary

## Fixed Ownership Decision

The first-phase boundary is fixed and must not drift:

| Capability | System of record | molingapi responsibility | AiOnline responsibility |
| --- | --- | --- | --- |
| Provider | `molingapi` | Provider metadata, protocol, endpoint defaults, enabled state, and capacity settings. | Display the management UI through the relay API when needed. |
| Key pool | `molingapi` | Store, encrypt, mask, rotate, select, rate-limit, and circuit-break provider keys. | Never receive provider key material in browser or user-facing responses. |
| Model | `molingapi` | Canonical `modelId`, display aliases, type, capabilities, parameter template, and enabled state. | Consume enabled model summaries for the workbench. |
| Routing | `molingapi` | Binding eligibility, route scoring, limits, cooldown/circuit state, and selected/rejected reasons. | Do not reimplement provider selection in the browser. |
| Task | `molingapi` | Idempotent generation task, provider attempts, status transitions, polling, SSE, and cancel release. | Submit through the relay and render the returned task state. |
| User | `AiOnline` | Accept an authenticated internal caller identity and enforce task ownership claims. | Own login, user records, roles, sessions, and user-facing authorization. |
| Credits | `AiOnline` | Report relay cost/usage metadata; never debit the user ledger. | Own reserve, commit, release, balance display, and the single billing reference. |
| Media | `AiOnline` | Return provider result metadata and stable task results. | Persist user media records, ownership, library state, and result associations. |
| OSS | `AiOnline` | Do not own OSS configuration, signing, namespaces, or upload workers. | Sign/ingest/finalize assets and persist the final media URL through the existing flow. |
| Payment | `AiOnline` | No recharge, order, webhook, or payment-provider behavior. | Own recharge packages, orders, payment providers, callbacks, and ledgers. |

This means the responsibility statement is exactly:

> molingapi 管 provider/key/model/routing/task，AiOnline 管 user/credits/media/OSS/payment。

## Request and Result Flow

```text
AiOnline user session
        |
        | authenticated internal generation request
        v
molingapi task boundary
        |
        +--> canonical modelId
        +--> enabled binding and key-pool route
        +--> provider submit/poll
        +--> task state, attempt record, SSE, cancel
        |
        v
stable task result and provider usage metadata
        |
        v
AiOnline credit finalization + existing media/OSS finalization
```

The result URL is not a new molingapi media record. AiOnline continues to run
the existing result-to-media process, including OSS ingest/finalization when
configured. A failed, canceled, or timed-out task may report a stable relay
error and cost reference, but it must not create a second credit transaction.

## HTTP Boundary

### Owned by molingapi

- `GET /v1/models`: enabled logical model summaries with canonical `modelId`.
- `POST /v1/generations`: idempotent task submission.
- `GET /v1/tasks/:taskId`: owner-scoped task snapshot.
- `GET /v1/tasks/:taskId/events`: owner-scoped task SSE.
- `POST /v1/tasks/:taskId/cancel`: idempotent cancellation and resource release.
- Admin provider/model/key/binding/routing endpoints, protected by admin
  authorization and revision-based optimistic locking.
- Temporary `/api/*` compatibility adapters needed by the existing Model Hub
  UI during migration.

### Must remain in AiOnline

- User/session/profile routes and user ownership checks.
- Credit balance, reserve/commit/release, ledger, recharge, and payment routes.
- Media CRUD, library, workspace, character/reference asset, and result
  persistence routes.
- OSS configuration, signing, ingest, namespace checks, and upload workers.

The browser continues to talk to AiOnline's consumer API surface during the
compatibility period. It must not receive provider base URLs, raw key data, or
the internal service credential. AiOnline's server-side adapter is the place
where the internal relay call is made.

## Data and Security Rules

1. `modelId` is the only stable model identity used for routing. Display and
   mapping names are aliases, not routing keys.
2. Provider credentials are server-side only and are represented externally by
   masked summaries. No credential value is placed in this document, a source
   inventory, a browser response, or a normal log line.
3. The same `(userId, idempotencyKey)` maps to one relay task and one upstream
   attempt sequence. Retry behavior must not cause a second AiOnline debit.
4. Task reads, SSE events, and cancel requests are scoped to the caller's
   user identity. Guessing a task ID cannot reveal another user's task.
5. `done`, `failed`, and `canceled` are terminal task states. They cannot be
   changed back to a running state.
6. Relay cost fields are for routing and observability. Only AiOnline performs
   the user-facing credit transaction.
7. Only AiOnline decides when and where a provider result becomes a durable
   user media record or OSS URL.

## Boundary Review Checklist

- A new provider integration changes molingapi provider/adapter code only.
- A new model or parameter template changes molingapi model data and its
  management API; the workbench renders the returned template.
- A routing policy change changes molingapi routing code and route explanations.
- A user balance or payment change changes AiOnline billing/payment code only.
- A media or OSS persistence change changes AiOnline media/OSS code only.
- Any proposed cross-boundary field has an owner, an authorization rule, and a
  single write authority before implementation.
