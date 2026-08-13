# Unified credential vault implementation plan

Status: implementation in this change.

## Goal

Give users one **Keys & OAuth** surface for model API keys, voice/STT keys, and credentials used by ephemeral machines. API keys can be created in the PWA before any node exists, synchronize end-to-end across account devices, and converge with a node when one is later connected. Hosted/unattended provisioning remains an explicit, separately escrowed scope.

## Scope model

| User-facing scope | Recipient/storage policy |
| --- | --- |
| This device | Encrypted browser/device storage only |
| This node | Encrypted node vault only |
| Account | E2E account vault shared with paired devices and enrolled nodes |
| Hosted / unattended | Explicit control-plane escrow, encrypted with the hosted account key and audited |

`Account` never implies `Hosted / unattended`. Hosted escrow is a separate, explicit authorization because it must work while every user device and node is offline.

## Implementation

1. **Generalize the device vault**
   - Version its encrypted payload and store both ephemeral compute-provider tokens and model API keys.
   - Keep legacy compute-token ciphertext readable.
   - Synchronize account-scoped model keys by default; keep compute-token sync opt-in.
   - Keep plaintext entirely in IndexedDB and E2E client memory; the control plane continues to store ciphertext and wrapped keys only.

2. **PWA ↔ node convergence**
   - Add a node protocol export containing only account-scoped, stored API-key records (no OAuth refresh tokens, command references, or node-local records).
   - On connection, merge node keys into the PWA account vault and push PWA account keys into the node vault.
   - Make writes idempotent and preserve the node vault as the runtime source of truth.

3. **One UI**
   - Move device/account API-key management to **Settings → Keys & OAuth**.
   - Allow adding API keys while no node is connected.
   - Display and edit explicit device/account scope.
   - Remove model-key controls from ephemeral-machine settings.
   - Keep cloud provisioning credentials represented separately because their permissions and hosted escrow differ.

4. **Voice in the same vault**
   - Resolve Groq/OpenAI STT through the model credential resolver.
   - Make voice settings select a provider only; direct users to Keys & OAuth to add/rotate/remove its key.
   - Keep environment fallback compatibility, but stop creating a separate `stt.*` secret.
   - Keep CLI compatibility by routing `bivy voice key/remove` to the unified model vault.

5. **Migration and compatibility**
   - Import existing browser ephemeral-model keys into the versioned account device vault.
   - Continue reading old local `stt.*` secrets as a temporary fallback, without writing new ones.
   - Preserve old device-vault compute-token payloads.

6. **Verification**
   - Unit-test versioned device-vault model-key sync, device-only exclusion, and legacy payload migration.
   - Test STT resolution from the credential vault and legacy fallback.
   - Typecheck root/core/web, run focused tests, then the repository test suite where practical.

## Security invariants

- The control plane cannot decrypt account-scoped device/node vault contents.
- `cmd://` and node-local credentials are never exported to a device.
- OAuth/subscription refresh tokens are never persisted in browser storage.
- Hosted secrets are accepted only when hosted encryption is configured, and their use remains audited.
- Removing a model key from ephemeral settings removes only the duplicate UI/path; ephemeral nodes receive the same account key used everywhere else.
