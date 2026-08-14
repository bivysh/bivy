# Keys & OAuth: product and architecture review

Status: proposal (2026-08-14)

## Recommendation

Build **one provider credential vault** and present it like a small password manager:

- The main screen lists credentials the user has saved, not every provider Bivy knows.
- **Add credential** opens a searchable, Bivy-owned provider catalog.
- Selecting an item opens one detail page for its sign-in method, availability, health, and usage.
- A user with one credential per provider sees no labels, presets, machines, or sync terminology.
- Multiple accounts and project routing are progressive disclosure.

Bivy should own a versioned provider catalog and a generated model catalog. The catalog is product metadata; it must not be derived only from whichever node and agent happen to be online.

## Why the current experience is difficult

The implementation has strong security machinery, but its product concepts expose storage topology rather than user intent.

### 1. There are two visible model-key stores

`Settings → Keys & OAuth` first renders `AccountApiKeys`, backed by the browser/device vault, and then renders provider credentials backed by the selected node (`packages/web/src/components/Settings.tsx`). A user can therefore encounter two Anthropic keys on the same screen with different controls and capabilities.

The stores are not equivalent:

- The device vault supports one API key per provider and `account | device` scope (`packages/core/src/device-vault.ts`).
- The node credential vault supports labeled records, API keys, OAuth, password-manager references, presets, and `account | node` sync (`src/credentials/*`).
- Browser/node convergence intentionally exports only account-scoped, default-label API keys (`exportAccountApiKeys` in `src/credentials/api.ts`).

This is technically honest but not one vault from the user's perspective.

### 2. The screen changes context between account and machine

The first section says account keys synchronize to devices and machines. The next section says keys are stored on each machine and asks the user to choose a machine. Then presets and a provider catalog apply to that selected machine. Users must understand the replication architecture before they can paste a key.

A machine is an availability/detail concern, not the primary navigation for credentials.

### 3. The main list is a provider catalog, not a vault

The provider list includes many “Not connected” rows. Password managers do the reverse: the main list contains saved items; a catalog appears only after pressing **Add**. This makes the normal state scannable and gives the empty state one obvious action.

### 4. “Scope”, “sync”, labels, and presets are mixed together

The sketch's `default / work / project1` values express **usage** (which credential should a context use), while the current `account / node / device` values express **availability** (where material may be used). These should not share a field or label.

Likewise, the current “active preset” is node-global, while the copy describes selecting keys “per project”. It is not a clear project binding. A global mode that can change credentials for unrelated sessions is surprising.

### 5. Provider identity depends too much on a live runtime

Credential listing still joins auth with Pi's provider catalog (`src/runtime/provider-catalog.ts`, `src/runtime/pi-oauth.ts`). The broader model catalog aggregates installed agent runtimes (`src/runtime/model-catalog.ts`). This means a node-less PWA cannot offer the same authoritative provider picker, and different machines can report different catalogs.

### 6. Status terms overclaim

“Connected” can mean stored, inherited from the environment, synced, or actually verified. The readiness model has already improved this, but the list still mixes these meanings. A vault item should distinguish:

- saved;
- available on this machine;
- verified;
- needs attention;
- unavailable here.

## Product model

Keep four concepts separate.

### Provider

Bivy-owned catalog metadata: Anthropic, OpenAI, Google, OpenRouter, etc. It defines supported sign-in methods, documentation, aliases, runtime projections, and known models. It contains no user secret.

### Credential item

One saved authentication item, analogous to one password-manager item:

```ts
interface CredentialItem {
  id: string;                         // stable opaque id
  providerId: string;
  name?: string;                      // hidden when only one; e.g. Work, Personal
  source:
    | { kind: "api_key"; secret: EncryptedSecret }
    | { kind: "oauth"; tokens: EncryptedOAuthTokens }
    | { kind: "reference"; ref: string }
    | { kind: "environment"; variable: string };
  availability:
    | { kind: "account" }
    | { kind: "node"; nodeId: string }
    | { kind: "device"; deviceId: string };
  unattendedAccess: boolean;          // separate explicit escrow grant
  origin: "bivy" | "agent-native";
  updatedAt: number;
}
```

A stable ID better matches vault semantics than using `provider:label` as identity: names can be edited, two credentials can have the same human title, and a rename need not become delete-plus-create. Moving from natural keys is not required for the first UX release, but it is the cleaner next schema when the record format changes again.

### Assignment

A separate rule says which credential to use:

```ts
interface CredentialAssignments {
  defaults: Record<ProviderId, CredentialId>;
  projects: Record<ProjectId, Record<ProviderId, CredentialId>>;
}
```

Rules:

1. Explicit session override.
2. Project assignment.
3. Account default for the provider.
4. The provider's only credential.
5. Ask when genuinely ambiguous.

Do not show assignments until a provider has at least two credentials. Rename “presets” to **credential sets** only if reusable cross-provider sets remain necessary. Otherwise direct project assignments are simpler and make the “per project” promise true.

### Availability

Use plain language:

- **All my machines** (default, E2E encrypted)
- **Only this machine**
- **Only this device** (only where meaningful)
- **Allow unattended runs** (separate opt-in, with custody explanation)

Do not call `work` or `project1` a scope. Those are names or assignments. Do not make hosted/unattended custody an implied consequence of account sync.

## Proposed interaction

### Vault list

```text
Keys & sign-ins                                      + Add

Search credentials…

Anthropic
  Personal                         OAuth      Ready
  Work                             API key    Ready

OpenAI
  Default                          API key    Needs verification
```

Only configured items appear. Optionally group by provider; recent/search views can follow password-manager patterns. If empty, show: “Add a model provider to start” and one **Add credential** button.

Use **Keys & sign-ins** or **Provider access** rather than “Keys & OAuth”. OAuth is implementation vocabulary; “sign-in” is clearer. “Credential vault” can be supporting copy, not necessarily the navigation title.

### Add flow

1. Search/select a provider from the Bivy catalog.
2. Choose one of the methods the catalog declares:
   - Sign in with subscription
   - Paste API key
   - Use password manager / environment
3. Save with defaults:
   - Name omitted (`Default` is implicit)
   - Available on all my machines
   - Unattended access off
4. Show advanced options only when requested.

For a custom OpenAI-compatible service, **Custom provider** is a catalog entry. It reveals endpoint, API compatibility, optional key, and model discovery. Free-text provider IDs should not be the normal path.

### Item detail

```text
Anthropic — Work

Method          API key ending …7K2
Status          Verified 5m ago
Available on    All my machines
Used by         Project Acme

[ Test ] [ Replace key ]

Advanced
  Password-manager reference
  Allow unattended runs          Off
  Machine availability…

[ Delete credential ]
```

Machine-by-machine information is an expandable availability/status view. Offline machines can be shown as “will sync when online”; the user should not have to switch the whole Settings connection merely to inspect the vault.

OAuth should use the same item page. If an online machine is required to complete the flow, Bivy chooses one automatically or asks only at that moment: “Use Laptop to complete sign-in.” That operational requirement should not structure the whole vault.

### Models remain separate

Credentials answer **“How may Bivy authenticate?”** Models answer **“What can I run?”** Keep a separate Models screen backed by the catalog. From an unavailable model, offer an inline **Add credential** action that opens the same add flow. Do not duplicate credential forms in model pickers and first-run sheets; reuse the same flow component and mutation API.

## Bivy-owned catalog

Owning the catalog does not mean manually hard-coding every model forever. Use two layers.

### Provider registry (authoritative and small)

Ship a signed/versioned registry to the web app, control plane, and node:

```ts
interface ProviderDefinition {
  id: string;
  name: string;
  aliases?: string[];
  icon?: string;
  docsUrl?: string;
  authMethods: Array<
    | { kind: "api_key"; label: string; helpUrl?: string }
    | { kind: "oauth"; oauthProviderId: string; label: string }
    | { kind: "reference" }
  >;
  projections: Array<{ runtime: string; env?: string[]; nativeStore?: string }>;
  api?: { compatibility: string; defaultBaseUrl?: string };
}
```

This registry becomes the single authority for provider naming, OAuth capability, API-key aliases (for example Codex subscription vs OpenAI API key), help links, and credential-to-runtime projection. Today these facts are spread across Pi's catalog, `MODEL_OAUTH_PROVIDERS`, environment mappings, local-model presets, and UI constants.

The PWA can then add a credential before any machine exists and validate the form consistently.

### Model catalog (generated, replaceable, layered)

Maintain a Bivy catalog snapshot generated from upstream provider APIs and certified runtime adapters. At runtime merge, in order:

1. Bivy's baseline catalog;
2. live provider discovery where supported;
3. installed-agent capabilities;
4. user-defined/local models.

Keep provenance and freshness on each model. Agent availability is a separate property from provider identity: “Claude Sonnet exists” and “this machine's installed agent can run it” are different facts.

A stale baseline is acceptable if clearly versioned; a missing catalog when no node is online is not.

## Architecture direction

### One logical vault, multiple eligible recipients

Retain the security boundaries, but stop exposing each replica as a different vault. Evolve the browser device-vault payload from `modelKeys[provider]` into the same record envelope used by nodes. Then synchronize item records according to availability:

- API keys may be wrapped to eligible account devices and nodes.
- Node-only and device-only records are filtered by recipient policy.
- OAuth token material may remain node-recipient-only while its encrypted metadata/item appears in the logical account vault.
- `cmd://` references remain node-only because syncing one would distribute executable commands.
- Hosted/unattended copies remain separately encrypted and audited.

The UI consumes one `vault.list` projection that returns item metadata plus per-target availability. It should not concatenate `listEphemeralModelKeys`, `providers.list`, and `credentials.list` itself.

### One command surface

The code currently retains default-provider APIs (`provider.apiKey`, `provider.remove`) beside labeled credential APIs (`credential.set`, `credential.remove`) and browser model-key APIs. Converge these behind item-addressed commands:

```text
vault.list
vault.item.create
vault.item.update
vault.item.delete
vault.item.test
vault.assignment.set
vault.availability.set
vault.oauth.start / complete
```

Legacy commands can call this service during migration. Every form—the vault, model picker, first-run repair, and CLI—should use the same create/update flow.

### Catalog is an injected dependency

The credential service already has the right boundary: provider metadata is injected rather than imported. Replace the Pi-only injection in `src/runtime/provider-catalog.ts` with the Bivy registry, then add runtime overlays. The encrypted store and sync protocol do not need to depend on model-catalog implementation.

## Migration plan

### Phase 1 — simplify without a vault schema change

- Replace the current screen with a configured-credentials list and **Add** catalog flow.
- Hide labels and assignments for providers with only one credential.
- Move machine selection into item availability details.
- Rename preset language and stop claiming project behavior unless a project binding exists.
- Use existing node and device APIs behind a temporary UI adapter.

This gives most of the usability improvement with low crypto risk.

### Phase 2 — own the catalog

- Add a versioned Bivy provider registry shared by web/core/node.
- Seed it from current Pi/runtime metadata and the native OAuth registry.
- Add a generated baseline model snapshot and merge runtime/live overlays.
- Remove the hard-coded `COMMON_MODEL_PROVIDERS` UI list.

### Phase 3 — unify account records

- Define a versioned item envelope common to device and node vaults.
- Migrate browser default API keys and node `provider:label` records into it.
- Preserve tombstones and timestamps; test mixed-version convergence.
- Expose a single redacted `vault.list` projection.

### Phase 4 — assignments and custody

- Add explicit account defaults and real project bindings.
- Make unattended access a separate, audited grant.
- Add per-machine availability diagnostics without machine switching.

## Decisions to make before implementation

1. Can OAuth token material be wrapped to browser devices, or should browsers receive item metadata only? Either is workable; the UI must describe availability accurately.
2. Are reusable cross-provider credential sets truly needed, or are provider defaults plus project assignments enough?
3. Is “This device only” useful for model credentials, or does “This machine only” cover the meaningful runtime case? Avoid offering both unless users can predict the difference.
4. Should account metadata (provider, item title, status) also be encrypted from the control plane? Password-manager expectations suggest yes.
5. Which provider/model catalog fields are compatibility promises, and how are registry updates signed and rolled back?

## Acceptance criteria

- A first-time user can add Anthropic or OpenAI without seeing machines, labels, presets, or sync internals.
- The same credential appears once, even if it is replicated to a browser and several machines.
- A node-less PWA can search the provider catalog and save an API key.
- OAuth uses the same add flow and asks for a helper machine only when required.
- A second credential for one provider reveals naming and assignment controls; the first credential remains the default automatically.
- Users can answer “where can this be used?” and “which projects use it?” from the item detail.
- Hosted/unattended custody is never enabled by ordinary account sync.
- Provider and model browsing works consistently with no machine online.
