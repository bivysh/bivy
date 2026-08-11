# Bivy platform modularization — sequencing plan

**Started:** 2026-08-11
**Status:** Active
**Decision record:** see [`product-roadmap-decisions.md`](product-roadmap-decisions.md) (D-003)
**Companion:** [`developer-platform-implementation-plan.md`](developer-platform-implementation-plan.md) — this plan supplies the *modularization spine* those phases assume.

## Objective

Turn Bivy from a daemon-with-seams into a **local-first kernel with removable
capability modules**, so that:

- developers can build against stable module contracts (agents, tools, clients,
  credential/policy brokerage) without editing the daemon;
- users get progressive activation (local works; remote/UI/TUI/automation are
  things you *add*);
- the business seam (open kernel + monetizable remote/governance + self-host
  escape hatch) falls out of the same boundaries.

Guiding principle (inherited from [`make-bivy-great-plan.md`](make-bivy-great-plan.md)):
*extend the existing seam, don't add a parallel one.* This is an architectural
evolution — `@bivy/core`, `@bivy/plugin-sdk`, the runtime registry, and the
`src/credentials/` extraction already exist — not a rewrite.

## Two claims that must stay separate

1. **Architecture invariant (pursue fully):** disabling or uninstalling a
   module — `remote` above all — must not break any local command or corrupt
   local state. Remote observes and exports through ports; it never *owns*
   sessions, credentials, scheduling, or agent execution.
2. **Product/setup direction (do NOT reopen here):** D-003 keeps relay/control-
   plane enrollment required in `bivy setup`, with self-host as the account-free
   path. Nothing below changes that. Local-first is an *architecture* property,
   not a setup mode.

Any future move to change (2) is a separate, deliberate decision-record entry —
not a side effect of this refactor.

## Why this order (moat context)

As of mid-2026 the *remote-steer* wedge is commoditizing (native Claude Code
Remote Control; self-hostable E2E relays like SeaWork; opencode's client/server
+ multi-client stack at ~160K stars). The defensible ground is the **agent-
agnostic governed substrate**: one policy/approval/credential/audit model across
*every* agent, driven by *any* trigger, across *many nodes you own*. So we
extract the commoditizing modules cleanly (necessary, not differentiating) and
spend the differentiation budget on governance + automation + multi-agent
(developer-platform Phase 5).

## Phases

Each phase is independently shippable and reviewable. `file:line` anchors are
from a read of the tree on 2026-08-11.

### Phase 0 — Make module boundaries machine-checkable *(this PR)*

The prerequisite for every extraction: a fitness check that fails CI when a
module imports across a forbidden boundary. Start it in **report mode** against
the credentials boundary (the pilot), then flip to **enforce** as each boundary
reaches zero violations.

- [x] `scripts/check-module-boundaries.mjs` — declarative boundary rules +
  scanner; `--enforce` exits non-zero on violation, default prints a baseline.
- [ ] Add `npm run check:boundaries` and wire it into CI (report-only until the
  pilot lands).

### Phase 1 — Pilot: finish the `@bivy/credentials` two-layer split

The smallest real instance of the whole pattern, and provably half-done today.
Detailed spec below. Exit criteria = the credentials boundary is clean and the
fitness check runs in `--enforce` for it.

### Phase 2 — Versioned command/event API (developer-platform Phase 4)

One contract behind CLI/REST/WebSocket/relay/SDK. Borrow opencode's proven
command/event-over-HTTP+SSE shape. Extract bounded controllers out of
`src/server.ts` (10,665 lines) — sessions, runtimes, tools, automations, plugin
lifecycle — behind the registry. Business logic leaves route/switch/controller
handlers; those only validate, authorize, dispatch.

**Grounding (read 2026-08-11): this EXTENDS an existing seam, not greenfield.**
`server.ts:2059` already has a unified dispatch (the referenced
`docs/dramatic-simplification-plan.md` is gone, but the code is live): a
`Command = (msg, ctx) => void | Promise<void>` type, a `CommandCtx { reply,
broadcast }`, and a `RELAY_COMMANDS` registry that `handleRelayMessage` consults
first, falling through to an inline switch for unmigrated kinds. **22 commands
are already migrated**, cleanly grouped by domain prefix — `session.*` (pause,
resume, question.answer, replay, rename, close), `node.*` (update, rename,
settings.get), `rulesets.*` (list, save, remove), `models.*`, `runtimes.*`,
`integrations.*`, `workspaces.*`, `github.app.*`, `provider.oauth.*`, plus
singletons (ping, abort, approval, attachment.fetch). **Those prefixes are the
bounded controllers.**

Phase 2 work, as slices (each its own PR against `main`):
1. **Controller extraction (the carve).** Move a prefix-group's handlers +
   the helpers they close over (e.g. `rulesets.*` with `persistRulesetSave` /
   `broadcastRulesets` / `rulesetInfos`) into a `src/controllers/<name>.ts`
   module that receives a typed context (`{ reply, broadcast, store, sessions,
   … }`) and registers into `RELAY_COMMANDS`. `server.ts` shrinks to
   composition. Start with a SMALL self-contained group as the proof —
   candidates: `rulesets` (3 handlers) or `node` (3). Same low-risk discipline
   as the credentials pilot (move + inject deps + keep the registry as the
   seam). A `controllers → server.ts` boundary rule guards it.
2. **Finish the migration.** Move remaining inline-switch kinds into the
   registry so there is one dispatch path.
3. **Version + validate the contract.** Add an explicit envelope version and
   runtime validation at the transport boundary (typebox is already a dep —
   see `integrations/registry.ts`). Derive REST/WS/relay routing from the
   registry. This is the durable public-API commitment (compat policy needed
   before third-party SDK consumers).

**Decision (2026-08-11): carve first, formalize later.** Extract controllers
behind the existing registry now (mechanical, low-risk, mirrors the credentials
pilot); add the versioned envelope + typebox validation as a later slice. The
contract is still internal (no external SDK consumers), so deferring is
low-cost and reversible.

**First-carve coupling note (read 2026-08-11):** `rulesets` is the smallest
candidate, but not fully isolated — its store ops already live in
`runtime/ruleset-store.ts`, yet `activeQueueRuleset()` feeds `queueRunPolicy`,
consumed by the work queue (not just commands). So the first controller PR must
either (a) move the whole ruleset concern (commands + `activeQueueRuleset` +
`queueRunPolicy` wiring) into `controllers/rulesets.ts` with `{ rulesetsDir,
broadcast }` injected, or (b) pick an even more isolated group (`node.*`:
update/rename/settings). **None of server.ts is type-strippable**, so the carve
is fully CI-verified — it warrants its own focused PR, not a tail-end change.
**First controller carve — DONE 2026-08-11 (branch `bivy/platform-phase2-rulesets-controller`).**
`rulesets` lifted into `src/controllers/rulesets.ts` behind
`createRulesetController({ rulesetsDir, broadcast })`; `server.ts` destructures
the five helpers back, so the RELAY_COMMANDS handlers, the REST `/api/rulesets`
routes, and the queue run-policy are unchanged. Added a
`controllers → server.ts` boundary rule (enforced). Also de-Pi'd the credentials
rule (dropped the redundant `/pi-oauth`, kept only the src-root `native-pi`) —
the rule is architectural, Pi-freeness falls out of it. Next: migrate the
command handlers + REST routes to register through the controller, then repeat
for the other prefix groups; version/validate the envelope later.

**Carve batch #2 (branch `bivy/platform-phase2-controllers`, PR against main):**
- **`workspaces` — DONE 2026-08-11.** Saved-workspace list helpers →
  `src/controllers/workspaces.ts` behind `createWorkspaceController({
  readSettings, writeSettings, metadata })`; destructured back; session-time
  project policy (`assertProjectModel`/`projectSafety`) stays in server.ts.
- **`models` — SCOPED, deferred to its own careful commit.** Cluster =
  `agentEnvForEndpoint` (models-only, move in), `currentProviderKeys`
  (models-only, move in), `writePiModelsProjection`, `localModelSummaries`,
  `migrateLegacyPiModelsIntoRegistry`, `initLocalModelRegistry`,
  `localModelSpecFromInput`, `broadcastLocalModels`, `persistLocalModelSave`,
  `persistLocalModelRemove`. Controller imports store fns from
  `runtime/local-model-store.js` + credential fns from `credentials/api.js`
  directly; injects 7 deps (`localModelsDir`, `piDir`,
  `piModelsProjectionPath`, `credsDir`, `broadcast`, `refreshSessionAfterAuth`,
  `pushModelAuthToControlPlane` — the last two are hoisted async fns).
  **HAZARD:** unlike rulesets/workspaces this cluster runs at boot (`void
  initLocalModelRegistry()`), so converting the hoisted `function`s to
  destructured `const`s has a boot-ordering constraint (instantiate after the
  const dir-deps; keep the boot call after). Not locally verifiable → do it as a
  dedicated commit with `tsc` available, not a blind batch.

**Deferred — NOT mechanical carves (engine work, dedicated PRs):** `runtimes.*`
(`getRuntime`/`ensureRuntimeAvailable` are the core runtime engine woven through
session creation) and `session.*` (the session lifecycle). `integrations.*`
needs no carve — already a proper `IntegrationManager` class.

### Phase 3 — Extract `@bivy/remote`

Relay transport + control-plane sync + remote session location, behind the ports
Phase 2 exposes (session-location registry — already layered via
`LayeredSessionLocationRegistry`, `src/server.ts:23`; a broadcast hook —
`broadcastLocalModels`/`broadcastRulesets`, `src/server.ts:399,447`; and a
sync-transport port whose first customer is the credential-record wire currently
stranded at `src/server.ts` ~L3379-3600). Guard: a "remote-absent daemon still
serves every local command" test.

### Phase 4 — CLI as a thin API client

`bin/bivy.mjs` (4,725 lines) keeps its service-management UX but routes feature
commands through the Phase 2 API instead of reaching into internals.

### Phase 5 — Governance depth (developer-platform Phase 5) — *the moat*

`delegate_task`, parent/child lineage, depth/time/cost limits, scoped policy,
isolated-worktree parallel comparison. This is the unoccupied competitive
ground; it gets the largest investment.

### Phase 6 — `@bivy/tui` (second independent client) — *last*

Proves the Phase 2 API works outside React. Deliberately last: opencode shows
multi-client is table stakes, not a differentiator.

### Phase 7 — Publish packages

Only after internal boundaries have held for a few releases. Don't publish
directories; publish contracts that have stopped moving.

## Fitness invariants (enforced by Phase 0 tooling)

- `src/credentials/**` imports nothing from `runtime/`, `agents/`, `session/`,
  `server.ts`, `secrets.ts`, or Pi — upward needs are injected ports.
- clients (`@bivy/core`, `@bivy/web`, future `@bivy/tui`) import no node
  implementation.
- `remote` may observe/export through ports but is never the authority for local
  state.
- integrations never bypass the runtime host.

---

# Pilot spec — `@bivy/credentials` two-layer split

## Current shape (the tangle)

```
credentials/{records,document,presets}.ts   PURE domain — leaf, good
credentials/api.ts        --imports-->  runtime/credential-store.ts   (vault engine)   ▲ up
credentials/records.ts    --imports-->  runtime/credential-store.ts   (StoredCredential type) ▲ up
credentials/document.ts   --imports-->  runtime/credential-store.ts   (Stored/OAuth types)    ▲ up
runtime/credential-store.ts --imports--> credentials/{document,records}.ts               ▼ down
runtime/credentials.ts     --imports--> secrets.ts (resolveSecret), oauth/model-oauth.ts ▲ up-from-service
runtime/provider-catalog.ts --imports--> pi-oauth.ts (Pi) + credentials/api.ts           (bridge — correct)
```

Two problems: (a) the domain's own vocabulary (`StoredCredential`,
`OAuthCredential`) lives in `runtime/`, so the pure layer points *up* to get its
own types; (b) the vault engine and resolver that *belong to* credentials live
in `runtime/`.

## Target shape (two layers, one direction)

**Layer A — pure domain** (`src/credentials/`, runs in Node + browser + tests,
no fs required, no Pi):
- `records.ts`, `document.ts`, `presets.ts` (unchanged, already pure)
- **NEW `types.ts`** — owns `StoredCredential`, `OAuthCredential`,
  `CredentialRecord`, `ProviderCredential`. `runtime/*` now imports these *down*.

**Layer B — node credential service** (`src/credentials/`, fs + crypto, still Pi-free):
- **MOVE** `runtime/credential-store.ts` → `credentials/store.ts` (the vault)
- **MOVE** `runtime/credentials.ts` → `credentials/resolver.ts` (selection +
  agent projection)
- both import Layer A *down*; everything that would point up becomes an injected
  **port**:

```ts
// credentials/ports.ts
export interface SecretResolver { resolve(ref: string): Promise<string | undefined>; }   // was ../secrets.ts
export interface OAuthRefresher { refresh(provider: string, label?: string): Promise<void>; } // was ./oauth/model-oauth.ts
export interface Sealer { seal(buf: Buffer): Buffer; open(buf: Buffer): Buffer; }         // was ../e2e.ts
export interface ProviderCatalog { list(): ProviderAuthInfo[]; }                          // Pi bridge (already inverted)
```

The service is constructed `createCredentialService({ dataDir, secrets, oauth,
sealer, catalog })`. Consumers (`src/server.ts`, `credentials-cli.ts`,
`runtime/*`) wire the real adapters — the Pi/secrets/e2e deps live on the
*consumer* side, matching how `joinProviderCatalog` already inverts the catalog.

`runtime/provider-catalog.ts` (the 19-line Pi bridge) **stays in runtime** — it
is the correct consumer-side bridge, not part of the service.

## Move sequence (each step independently verifiable)

1. **Types down (safe, mechanical). — DONE 2026-08-11.** Created
   `credentials/types.ts` (pure leaf) owning `ApiKeyCredential`,
   `OAuthCredential`, `StoredCredential`; re-pointed
   `credentials/{records,document,api,index}.ts` down to it;
   `runtime/credential-store.ts` now imports them down and re-exports for
   compatibility (kept `test/credential-merge.test.ts` + runtime consumers
   working). Boundary check: **7 → 5** violations (both type-only edges gone;
   the 5 remaining are the vault/resolver/Pi-bridge *value* imports handled by
   steps 3–4). Pure files verified via `node --experimental-strip-types
   --check`. NOT locally verifiable: `tsc --noEmit` (no tsc in this worktree)
   and `credential-store.ts` runtime behavior → CI + live sign-in smoke.
2. **Ports — declare contracts (additive). — DONE 2026-08-11.** Added the pure
   leaf `credentials/ports.ts`: `Sealer` (mirrors `e2e.ts` seal/open),
   `SecretResolver` (wraps `secrets.ts` resolveSecret, data dir bound on the
   consumer side), `OAuthRefresher` (wraps `oauth/model-oauth.ts`
   refreshModelOAuth, creds dir bound consumer-side). Exported from `index.ts`.
   The provider catalog is already inverted (`joinProviderCatalog` +
   `runtime/provider-catalog.ts`), so it is not re-declared. Concrete adapters
   are deliberately NOT created yet — nothing consumes them until the engines
   move, so they are wired in step 3 at the construction site (avoids dead
   speculative shims). Verified via strip-parse; no behavior change.
3. **Move the vault — DONE 2026-08-11 (branch `bivy/credentials-two-layer-engine-move`).**
   `git mv runtime/credential-store.ts → credentials/store.ts`; fixed its
   in-layer import paths; wired the `Sealer` port through the constructor
   (`sealer: Sealer = nodeSealer`, default = the `e2e` adapter) so **no caller
   changes** — `createCredentialVault` gained an optional `sealer` param. Left a
   re-export **compat shim** at `runtime/credential-store.ts` so server.ts,
   bivy-login.ts, and ~18 test files keep working; added `CredentialRecord` to
   the shim (the original leaked it via type-erasure only). Re-pointed
   `credentials/{api,index}.ts` to `./store.js`. **Decision:** `e2e.ts` is a
   repo crypto leaf, NOT on the forbidden list — Layer B may use it directly;
   the `Sealer` port abstracts it for a future browser build (phase 7). Removed
   the over-strict `../e2e` rule from the checker. Boundary: **5 → 2** (only the
   resolver + the sanctioned Pi bridge remain). Checkable files strip-parse;
   `store.ts` itself (parameter properties) + auth behavior → **CI + live
   sign-in smoke before merge** (see project memory on commit 902b4ea).
4. **Move the resolver — DONE 2026-08-11 (branch `bivy/credentials-two-layer-engine-move`).**
   `git mv runtime/credentials.ts → credentials/resolver.ts`; inverted the two
   upward deps via ports — `resolveSecret` → `SecretResolver`,
   `refreshModelOAuth` → `OAuthRefresher` — so `resolver.ts` imports nothing
   upward. `NodeCredentialResolver`/`createCredentialStore` now take the two
   ports; a **shim** at `runtime/credentials.ts` binds the node adapters
   (`resolveSecret(ref, appDir)`, `refreshModelOAuth(credsDir, …)`) and keeps
   the historical `createCredentialStore(credsDir)` signature, so all ~10
   callers (server.ts, runtime/index.ts, agents, provisioning, tests) are
   unchanged. Also moved `ProviderCredential` + `AgentCredentialStore` into
   `credentials/types.ts`, re-exported from `runtime/types.ts` (process.ts,
   protocol.ts, claude-code/runtime.ts unchanged).
5. **Flip the fitness check to `--enforce` — DONE 2026-08-11.** Credentials
   boundary is **0 violations, enforced**. Added an `allow` exception for the
   one sanctioned bridge (`runtime/provider-catalog.js`). Still TODO: wire
   `npm run check:boundaries` into CI (needs the deferred `package.json` edit).

**Phase 1 status:** structurally COMPLETE (steps 1–5). Layer A = pure domain
(`types/records/document/presets/ports`); Layer B = node service
(`store/resolver/api`) behind injected ports. Shipped as **#460** (steps 1–2,
green) and **#461** (steps 3–5, stacked). ⚠️ **Merge gate on #461:** live
sign-in + `env://` reference smoke on a running daemon (auth-fragile OAuth
path, unverifiable headless).

Steps 1–2 and 3–5 shipped as **separate PRs** (types+ports first, engine moves
second) so the fragile moves stay small and revertable.

## Verification

- `node scripts/check-module-boundaries.mjs` → credentials violations reach 0.
- Existing guards keep passing: `test/credential-store-v3.test.ts`,
  `credential-store-records.test.ts`, `credentials-reference.test.ts`,
  `credential-sync-policy.test.ts`, `credential-record-sync.test.ts`.
- CI typecheck (`tsc --noEmit`) green — the only reliable check for
  `credential-store.ts`.
- Live smoke: one real model sign-in + one reference (`env://`) resolve on a
  running daemon before merging step 3.

## Why this is the right pilot

- Smallest module that already has all the moving parts (pure domain, fs
  service, injected secrets, Pi bridge, cross-node sync customer).
- Provably half-extracted, so success is measurable (violations → 0).
- Its ports (`SecretResolver`, `Sealer`, sync-transport) are the *same* seams
  Phase 3 (`@bivy/remote`) needs — the pilot validates the fitness tooling and
  the port pattern before we point them at `server.ts`.
- Highest standalone value: a Pi-free, browser-capable credential/policy broker
  is a module with a story *outside* Bivy.
