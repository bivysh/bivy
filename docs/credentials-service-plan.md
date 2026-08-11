# Credential service — design & extraction plan

Status: proposed (2026-08-11). Extract Bivy's model-credential handling into a standalone,
agent-independent service inside the repo, and extend it to support multiple credentials per
provider, multiple accounts, unified login sources, password-manager references, and
per-credential opt-out sync.

Related: [credential-sync.md](credential-sync.md), [key-management.md](key-management.md),
[config-as-code.md](config-as-code.md), [security-model.md](security-model.md).

---

## 1. Goals

1. **Standalone & reusable.** A self-contained credential store that could later be lifted
   into its own package, with no dependency on any agent runtime.
2. **Agent-independent.** The core knows about *credential records*, not about Claude Code,
   Codex, Pi, sessions, or the control plane.
3. **Multiple credentials per provider** (split keys across projects).
4. **Multiple accounts** (work + personal) as labeled credentials.
5. **Unified login sources.** Bivy-first (`bivy login`, PWA), agent-native (`codex login`,
   `claude /login`, Pi TUI), and password-manager references all land as records in one store.
6. **Opt-out cross-machine sync, per credential.**
7. **One experience locally and over the PWA** — same API, same behavior.

Non-goal: replacing the E2E sync transport, the OAuth engine, or the crypto. Those are
reused; this plan draws a boundary around them and changes the data model they operate over.

**Overriding constraint (Simple Made Easy):** prefer one mechanism over two, values over
modes, and a single default-happy path. The multi-credential machinery must be *invisible*
to a user with one key per provider (see §7).

---

## 2. What exists today (baseline)

The logic already lives in focused, single-responsibility modules.

| Module | Responsibility | Coupling |
| --- | --- | --- |
| `src/runtime/credential-store.ts` | **The vault.** Encrypted (AES-256-GCM via `e2e.ts`), cross-process lock, single write path `modify()`, CRDT-style merge (`importAll`/`exportAll`, tombstones, `preferIncomingCredential`, `tombstoneWins`). | **None** — Pi-free; imports only `e2e.ts` + stdlib. |
| `src/runtime/credentials.ts` | Resolve a credential → **agent env vars** (`buildAgentCredentialEnv`, `apiKeyEnvVar`). | Agent-facing, read-only over the vault. |
| `src/runtime/pi-auth.ts` | Daemon credential API (`setProviderApiKey` / `removeProvider` / `export`/`import` …). **Despite the name, this is our own auth** — all storage ops hit our vault with zero Pi. The *only* Pi touch is the provider **catalog** (`{id,name,oauth}`). | Misnamed; near-zero Pi. |
| `src/runtime/credential-ingest.ts` | Fold **agent-native logins** back into the vault (adapters per agent). | Per-agent adapters. |
| `src/runtime/credential-provisioning.ts` | Project the vault **out** to an agent's native store / env; single OAuth-refresh authority. | Per-agent adapters. |
| `src/runtime/oauth/model-oauth.ts`, `pi-oauth.ts` | OAuth login/refresh; provider catalog (from Pi). | Isolated Pi bridge. |
| `src/secrets.ts` | Separate **secret vault** with `op://` / `env://` / `secret://` reference resolution (`resolveSecret`). Backs GitHub/integration secrets today — **not** model keys. | Standalone. |
| `src/server.ts` (~3270–3541) | **Cross-node sync transport** — model-auth envelope, node→node key wrapping, revocation. | Entangled in `server.ts`. |

**Facts that shape the plan:**

- The vault is keyed `Record<providerId, StoredCredential>` — **one credential per provider.**
  This is the wall goals #3/#4 hit; it is the one real schema change.
- `credential-store.ts` is the clean seam; the convergence logic is already pure/tested.
- OAuth **refresh** is provider-addressed today (`model-oauth.ts` `modify(providerId, …)`).
  With multiple OAuth logins per provider this must become **record-addressed** (§8).
- Password-manager keys currently bypass the credential vault entirely (via `cli.json` env),
  so they get no label/preset/UI. §3.2 folds them in as a first-class source.

---

## 3. Architecture

### 3.1 Boundary — one API, two clients

Extract the credential modules into `src/credentials/` behind a single entry point. Package
promotion is deferred until the code is actually reused elsewhere — the boundary matters now.

```
   LOCAL                                  REMOTE
 ┌─────────┐                          ┌─────────┐
 │  bivy   │                          │   PWA   │
 │  CLI    │                          │ (browser)
 └────┬────┘                          └────┬────┘
      │  add / label / set-preset          │   (over E2E relay)
      └──────────────┬─────────────────────┘
                     ▼
        ┌─────────────────────────────┐
        │   DAEMON API (ours)          │   ← EVERY mutation goes through here,
        │   src/credentials/api.ts     │      so CLI & PWA can never drift
        └──────────────┬──────────────┘
                       ▼
   ╔══════════════ src/credentials/  (the service) ═══════════════╗
   ║   imports NOTHING from agents / session / control-plane      ║
   ║   records.ts ── resolveCredential()  ◄── presets.ts          ║
   ║       ▼                                                      ║
   ║   vault.ts  (encrypted, lock, merge, tombstones)            ║
   ║       ▼                                                      ║
   ║   sync.ts  (pure export/import — filtered by sync policy)    ║
   ╚═══════╪══════════════════╪══════════════════╪═══════════════╝
           │ inverted deps (passed in, never imported)            │
    ┌──────▼─────┐  ┌──────────▼───┐  ┌──────────▼───┐  ┌─────────▼────────┐
    │resolveSecret│ │ OAuth refresh│  │provider      │  │ E2E sync transport│
    │(1Password)  │ │ (Pi bridge)  │  │catalog {id,  │  │ (server.ts)       │
    └─────────────┘ └──────────────┘  │name,oauth}   │  └───────────────────┘
                                      │(Pi today,    │
      agent env-injection lives OUT   │ ours later)  │
                                      └──────────────┘
```

**The rule that makes it both simple and reusable:** `src/credentials/` imports nothing from
`agents/`, `session/`, or the control plane. Every external need — secret resolution (1Password),
OAuth refresh (Pi), the provider catalog, sync transport, env injection — is *inverted*: passed
in as a function/value, never imported. Consequences:

- The service compiles and tests **without Pi at all** (feed it a fake catalog) — this is the
  "standalone / reusable" requirement made real.
- Dropping Pi later means replacing one injected `{id,name,oauth}[]` list; nothing else changes.

Concrete cleanups this phase makes:

- **Rename** `pi-auth.ts` → `src/credentials/api.ts`. It is our auth; the name should say so.
- **Split env injection at the joint:** the *service* owns the pure `record → canonical env
  representation` (the provider→var map); the *agent* owns the act of injecting into its
  subprocess. Don't exile all env logic — split it where the responsibility actually changes.

### 3.2 Data model — the one real change

Today: `document.providers: Record<providerId, StoredCredential>` (one per provider).

Proposed — a credential is a first-class record, **keyed by its natural `provider:label`**:

```ts
type SyncPolicy      = "account" | "node";
type CredentialOrigin = "bivy" | "agent-native";

type CredentialSource =
  | { kind: "stored";    cred: StoredCredential }                    // secret in auth.enc (today)
  | { kind: "reference"; ref: string; backend: "1password" | "env" }; // pointer, resolved per-node

interface CredentialRecord {
  provider: string;   // "anthropic"
  label:    string;   // "work" — unique per provider
  source:   CredentialSource;
  sync:     SyncPolicy;
  origin:   CredentialOrigin;   // display + default-picker only, never branches behavior
  updatedAt?: number;
}

document.credentials: Record<"provider:label", CredentialRecord>
document.deletedAt:   Record<"provider:label", number>   // tombstones re-keyed
```

**Why the natural `provider:label` key, not a synthetic uuid:** if you create `anthropic:work`
independently on two machines, they converge to *one* record through the existing freshest-wins
merge. A uuid would sync into two duplicate "work" keys. The natural key also removes a
label→id indirection (a preset's value *is* the key) and gives label-uniqueness-per-provider
for free. Cost: a rename is delete+create (a tombstone + a record) — rare and arguably clearer.

`StoredCredential` (`api_key`/`oauth`) is **unchanged** — labels/accounts/references are metadata
*around* it, not a new credential type.

**Reference credentials (password managers):** a `reference` record holds only a pointer
(`op://…`). It is resolved **lazily, per-node**, by the *existing* `resolveSecret()` — the
materialized secret is never written into `auth.enc`, and there is no third crypto path. This is
where the two vaults finally meet through one clean function instead of the `cli.json` side
channel. References are **api-key-shaped only** (a static pointer can't model a rotating OAuth
token set), and are a **bivy-first** concept (agent-native ingest always yields raw `stored` keys).

**Backward compatibility:** a `v2` doc migrates to one `v3` record per provider with
`label:"default"`, `origin:"bivy"`, `sync:"account"` — mirroring the existing `v1→v2` migration
in `readDocument()`/`ensureMigrated()`. `getCredential(provider)` keeps working by delegating to
`resolveCredential(provider)`. Nothing downstream breaks on day one.

### 3.3 Selection — manual, driven by config presets

Selection is **data, not logic**: a pure function over records + a config file (config-as-code).
It never lives in the vault write path.

```jsonc
// .bivy/credentials.config.json
{
  "active": "default",
  "presets": {
    "default":      { "anthropic": "personal", "openai": "personal" },
    "project:acme": { "anthropic": "work",     "openai": "work-acme"  }
  }
}
```

`resolveCredential(provider, records, presets, { preset?, preferLabel? })` — ladder, simplest
first, and it **returns what it chose and why**:

1. explicit `preferLabel` (a per-session override) → *"explicit label"*
2. the active preset's `provider → label` mapping → *"preset:acme"*
3. the `"default"` preset → *"default preset"*
4. a record labeled `default`, else the provider's **only** record → *"only credential"*
5. otherwise **undefined** (ambiguous) — the caller surfaces "choose one", never a silent pick.

A preset referencing a label that doesn't exist on this node is a **visible warning** (a
`doctor` check + a PWA badge via `missingPresetLabels()`), never a silent downgrade to another key.

**PWA:** the Models screen lists credentials by label per provider, shows the active preset, and
writes through the daemon API (§3.1) — the same path the CLI uses. One source of truth, two clients.

### 3.4 Sync — opt-out, as policy-as-data

Sync is a value on each record, not a global mode. Three honest tiers on one `sync` field:

| Source | Tier | Behavior |
| --- | --- | --- |
| `stored` + `sync:"account"` | secret syncs E2E | today's model (default for bivy-first) |
| `stored` + `sync:"node"` | secret stays put | opt-out for a machine-local key |
| `reference` | pointer syncs, secret resolved per-node | portable everywhere, secret never leaves the PM |

The export step (`sync.ts`, lifting the glue currently in `server.ts` ~3270–3541) **filters to
`sync === "account"`** before sealing the existing E2E envelope, and for a `reference` exports
the pointer, never a resolved secret. Transport, key wrapping, and revocation (tombstones) are
unchanged — this only changes *which records* enter the envelope.

### 3.5 Agent-native ingest — unified, additive, non-destructive

Bivy already folds native logins back into its vault (`credential-ingest.ts`). This stays and
becomes record-shaped. **What Bivy can pick up:**

| You logged in via… | Lands as provider | Auto-ingested? |
| --- | --- | --- |
| `codex login` | `openai-codex` (or `openai` for `--api-key`) | ✅ `codexAuthToCredential` |
| `claude /login` (file **or** macOS Keychain) | `anthropic` | ✅ `claudeAuthToCredential` |
| `grok login` | `xai` | ✅ `grokAuthToCredential` |
| Pi TUI login | via plaintext `auth.json` | ✅ `ingestPlaintext()` |
| Gemini CLI, generic/OpenCode/Goose | — | ❌ no adapter → per-node native login |

**Triggers:** on `bivy run <agent>` terminal exit, and via the `auth.json` watcher. So pickup
happens **when Bivy next runs or watches that agent**, not the instant you log in elsewhere. Merge
is rotation-safe, so re-ingesting the same login is harmless.

**The rule that makes ingest safe under multi-credential:** an ingested login lands under a
**reserved, agent-derived label** — e.g. `anthropic:claude-code`, or the OAuth `account_id` when
present — **never `default`**. Otherwise a Claude native login (provider `anthropic`) would
merge-clobber a Bivy-managed `anthropic:default` via freshest-wins. Reserved labels make ingest
**additive**: the native login appears as a *separate selectable credential* beside your Bivy keys,
directly serving the multi-account goal. Ingested records default to `origin:"agent-native"`,
`sync:"node"` (they don't leave the machine unless you promote them). Bivy reads *from* an
`authOwner:"agent"` store; it never fights it.

---

## 4. Simplicity guardrails

Keep these concerns decomplected — separate values/functions, never entangled:

- **Storage** (encrypt/lock/persist) — isolated in `vault.ts`. Nothing else in.
- **Convergence** (tombstones, freshest-wins) — pure, testable without a vault.
- **Selection** — a pure function over records + config, not a method that also writes.
- **Sync policy** — a data field + a filter, not a mode threaded through call sites.
- **Env injection** — the service owns the canonical env representation; the agent owns injection.

One rule holds the line: the core imports nothing from `agents/`, `session/`, or the control
plane. The moment it needs one, invert it. `origin` labels provenance and picks a default; the
moment behavior forks on `origin` instead of `sync`, complexity has crept back.

Resist these expansions: presets fully replace any per-credential `scope[]` (one mechanism);
references reuse `resolveSecret()` (no new backend); merge logic is re-keyed, not rewritten;
never inject more than one key per provider into a process (selection has already collapsed to one).

---

## 5. Robustness & failure modes

- **Zero-config path is sacred** (§7): one key per provider ⇒ no labels, no presets file, no new concepts.
- **Ambiguous selection never guesses** — returns undefined; caller asks the user to choose.
- **Dangling presets warn**, never silently downgrade.
- **Reference resolution is per-node and may fail** (no `op` CLI / not signed in). Show a
  per-node status (`resolved` / `op not signed in` / `ref not found`); a PWA user can't `op signin`
  remotely, so the message is actionable ("Sign in to 1Password on node *laptop*"), not a fallback.
- **Malformed `credentials.config.json`** → validated by schema (zod/typebox); on error fall back
  to the implicit default and surface a clear message — never a broken credential path.
- **Downgrade honesty:** a `v3` vault read by an older binary looks empty (ciphertext safe, not
  lost) ⇒ re-login on downgrade. Acceptable pre-release; documented, not discovered.

---

## 6. Phased plan

Each phase ships independently and leaves the app working.

1. **Foundation.** ✅ *(shipped)* `src/credentials/` with the pure `records.ts` (record model,
   natural key, `resolveCredential`, reserved-label + preset helpers) + `index.ts` facade + `README`.
   Purely additive, non-breaking; unit-tested.
2. **Vault `v3` schema.** ✅ *(shipped)* `document.ts` — the v3 schema
   `Record<"provider:label", CredentialRecord>`, `v1/v2 → v3` migration (`migrateToV3`, legacy/v2
   creds become `provider:default`, tombstones re-keyed), and the re-keyed non-destructive merge
   (`mergeDocuments`, `preferIncomingRecord`, `tombstoneWinsRecord`) — the v2 rules re-keyed to
   records, unit-tested standalone. `credential-store.ts` now persists v3 and migrates any prior
   encoding on read, while its public surface (`read`/`list`/`modify`/`delete`/`export`/`import`/
   `materialize`) keeps exchanging today's provider-keyed `StoredCredential` shapes via the
   `provider:default` record — so no caller, wire format, or sign-in behavior changes. Multi-label
   storage is enabled but not yet exposed (that surface is phase 5). Guarded by
   `test/credential-store-v3.test.ts` (existing v2 vault → v3 migration, write-upgrades-encoding,
   tombstone + import convergence).
3. **`resolveCredential` + presets wired in.** Route `getCredential`/env projection through
   selection; add `credentials.config.json` (schema-validated). Behavior identical at one cred each.
4. **Reference source + `resolveSecret` bridge.** Add the `reference` kind end-to-end; deprecate
   the `cli.json` model-key side channel.
5. **Multi-credential API + UI + ingest labels.** `api.ts` gains add/label/remove/list; PWA Models
   screen gets labels + preset picker; ingest lands under reserved labels; catalog injected.
6. **`sync` field + opt-out filter + record-addressed OAuth refresh.** Lift transport behind
   `sync.ts`; filter by policy; refresh the specific record (dedicated two-oauth-per-provider test).
7. **(Later) Package promotion** — a `package.json`, because the boundary was drawn in phase 1.

---

## 7. The zero-config guarantee (acceptance test)

A fresh user runs `bivy login`, pastes one Anthropic key, and sees **zero** new concepts — no
label prompt (defaults to `default`), no presets file required (absent file ⇒ implicit
`{ default: <the one credential> }`), same env injection as today. Any phase that breaks this is wrong.

---

## 8. Known touch-points in delicate code (call out, test hard)

- **OAuth refresh becomes record-addressed.** `model-oauth.ts`/`NodeCredentialResolver` are
  provider-addressed today. Two OAuth logins per provider ⇒ refresh the *specific* record, or a
  single-use rotated refresh token corrupts the wrong account. Cover with an explicit test.
- **Merge re-keys to `provider:label`.** Pure functions unchanged in rule; the key type changes.
- **Ingest labeling.** The reserved-label rule (§3.5) is what keeps ingest from clobbering.

---

## 9. Open questions

- Preset config home: a dedicated `.bivy/credentials.config.json` (leaning this — clean sync/ignore
  story) vs. a block in the existing config-as-code file.
- Per-session override storage: session metadata vs. only the preset file.
- Reserved-label naming for ingest: agent id (`claude-code`) vs. OAuth `account_id` when present.
