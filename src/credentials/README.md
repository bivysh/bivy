# `src/credentials/` — the credential service

A standalone, agent-independent service that owns Bivy's model-provider
credentials: storage, the record model, selection, and (as it grows) sync policy.
Import it through the single entry point:

```ts
import { resolveCredential, credKey, createCredentialVault } from "../credentials/index.js";
```

## The one rule

**This directory imports nothing from `runtime/`, `agents/`, `session/`,
`server.ts`, `secrets.ts`, or Pi.** Every external need is *inverted* — passed
in as a port (interface in `ports.ts`), never imported. The rule is
machine-enforced: `scripts/check-module-boundaries.mjs` runs in `--enforce`
mode for this directory (0 violations).

| Need | Injected as (`ports.ts`) | Node adapter bound in |
| --- | --- | --- |
| Secret resolution (`op://`/`env://`/`cmd://`) | `SecretResolver` | `runtime/credentials.ts` shim |
| OAuth refresh | `OAuthRefresher` | `runtime/credentials.ts` shim |
| At-rest crypto (AES-256-GCM) | `Sealer` (defaults to the `e2e` adapter) | `store.ts` (`nodeSealer`) |
| Provider catalog `{ id, name, oauth }` | injected list via `joinProviderCatalog` | `runtime/provider-catalog.ts` (the one allowed bridge) |
| Cross-node sync transport | bounded export interface | the E2E envelope in `server.ts` |

That rule is what makes the service both **simple** (each concern stays
decomplected) and **reusable** (it compiles and tests without Pi, and can be
lifted into its own package by adding a `package.json`).

## Two layers

- **Layer A — pure domain** (Node + browser + tests, no fs/crypto): `types.ts`,
  `records.ts`, `document.ts`, `presets.ts`, `ports.ts`.
- **Layer B — node service** (fs + crypto, still Pi-free): `store.ts` (the
  encrypted vault engine), `resolver.ts` (selection + agent env projection),
  `api.ts` (the daemon credential API). Layer B imports Layer A downward and the
  injected ports; nothing points up.

## What's here now (two-layer split complete)

- **`types.ts`** — the pure credential vocabulary: `ApiKeyCredential`,
  `OAuthCredential`, `StoredCredential`, and the resolution contracts
  `ProviderCredential` / `AgentCredentialStore`. No imports (leaf).
- **`ports.ts`** — the injected-capability interfaces (`Sealer`,
  `SecretResolver`, `OAuthRefresher`). No imports (leaf).
- **`store.ts`** — the encrypted vault engine (`BivyCredentialStore`,
  `createCredentialVault`): AES-256-GCM at rest via the injected `Sealer`,
  cross-process lock, v3 document persistence, record CRUD + CRDT merge.
- **`resolver.ts`** — `NodeCredentialResolver` / `createCredentialStore` /
  `buildAgentCredentialEnv`: selects a record per the active preset and projects
  it into the env an agent process reads, resolving references and refreshing
  OAuth through the injected ports.
- **`records.ts`** — the pure, I/O-free record model and selection:
  - `CredentialRecord` keyed by its natural identity `provider:label` (so the
    same logical credential created on two machines converges via the vault's
    freshest-wins merge instead of forking into duplicates).
  - `CredentialSource` = `stored` (secret in the vault) or `reference` (an
    `op://…` pointer resolved lazily, per-node — the secret never enters the vault).
  - `resolveCredential(provider, records, presets, request)` — a pure selection
    ladder that returns the chosen record **and a reason**, and returns
    `undefined` on ambiguity rather than silently guessing between accounts.
  - `agentNativeLabel()` — the reserved label an ingested agent-native login
    lands under, so it can never clobber a Bivy-managed `provider:default` key.
  - `missingPresetLabels()` — dangling-preset detection for `doctor` / PWA warnings.
- **`document.ts`** — the v3 vault document engine (also pure): the
  `provider:label`-keyed schema, `v1/v2 → v3` migration (`migrateToV3`), and the
  non-destructive merge (`mergeDocuments`, `preferIncomingRecord`,
  `tombstoneWinsRecord`) — the v2 convergence rules re-keyed to records. This is
  what `credential-store.ts` will delegate to so the vault persists v3; it is
  verified standalone because the vault's fs/crypto glue is auth-critical.
- **`presets.ts`** — selection presets + ingest policy (`credentials.config.json`):
  pure `parsePresets` / `resolveCredential` inputs, and `parseIngestPolicy`
  (`merge` | `separate`) for agent-native logins.
- **`api.ts`** — the daemon credential API (formerly `runtime/pi-auth.ts`), Bivy's
  own auth surface: `set*` / `remove*` / `export*` / `import*` and the labeled
  multi-credential functions, plus `joinProviderCatalog(credsDir, catalog)`.
  **Pi-free** — the provider catalog is injected; `runtime/provider-catalog.ts`
  supplies Pi's.
- **`index.ts`** — the public facade over all of the above.

## Roadmap

See [`docs/credentials-service-plan.md`](../../docs/credentials-service-plan.md)
and the modularization sequencing in
[`docs/internal/platform-modularization-plan.md`](../../docs/internal/platform-modularization-plan.md).
The vault and resolver now live under this directory (two-layer split complete),
and compatibility shims remain at `runtime/credential-store.ts` and
`runtime/credentials.ts` for existing importers. The last step is a
`package.json` that lifts the service out whole (plan phase 7). Each change is
additive; the zero-config single-credential experience stays unchanged.
