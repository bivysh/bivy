# `src/credentials/` — the credential service

A standalone, agent-independent service that owns Bivy's model-provider
credentials: storage, the record model, selection, and (as it grows) sync policy.
Import it through the single entry point:

```ts
import { resolveCredential, credKey, createCredentialVault } from "../credentials/index.js";
```

## The one rule

**This directory imports nothing from `agents/`, `session/`, or the control
plane.** Every external need is *inverted* — passed in as a value or function,
never imported:

| Need | Injected as |
| --- | --- |
| Secret resolution (1Password / env) | `resolveSecret()` from the secret vault |
| OAuth refresh | a refresh function (Pi bridge today) |
| Provider catalog `{ id, name, oauth }` | a plain list (Pi today, Bivy-owned later) |
| Cross-node sync transport | the E2E envelope in `server.ts` |
| Agent env injection | the agent runtime consumes the canonical env representation |

That rule is what makes the service both **simple** (each concern stays
decomplected) and **reusable** (it compiles and tests without Pi, and could be
lifted into its own package by adding a `package.json`).

## What's here now (phase 1)

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

See [`docs/credentials-service-plan.md`](../../docs/credentials-service-plan.md).
The remaining work: the PWA Models screen, per-credential opt-out sync + a
record-shaped sync wire (so `separate`/reference credentials can travel), and
finally moving the vault (`runtime/credential-store.ts`) and resolver physically
under this directory so a `package.json` lifts the service out whole. Each phase
is additive; the zero-config single-credential experience stays unchanged.
