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
- **`index.ts`** — the public facade. Ships the new model and re-exports the
  existing credential surface so new code can already import from here.

## Roadmap

See [`docs/credentials-service-plan.md`](../../docs/credentials-service-plan.md).
Later phases move the vault, resolver, ingest/provisioning, and daemon API under
this directory (renaming the misnamed `runtime/pi-auth.ts` → `api.ts`), add the
`v3` multi-credential schema + migration, wire selection into the live path, add
the reference source, and lift sync policy behind `sync.ts`. Each phase is
additive and independently shippable; the zero-config single-credential
experience must stay unchanged throughout.
