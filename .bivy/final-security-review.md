# Credential vault final security review

Reviewed `origin/main...HEAD` at `6d08167`, focusing on hosted custody, mixed versions, convergence, assignment resolution, and direct/relay parity.

## Blockers

- **CRITICAL — Revoking unattended custody does not revoke a running hosted node.** `src/server.ts:3691-3694` merges the filtered hosted snapshot non-destructively, while `src/server.ts:3744-3746` encodes only currently allowed records and always sends an empty hosted tombstone map. After `unattended` is cleared (or the credential is deleted/made node-only), the next snapshot merely omits the record; an already hydrated hosted runner retains the old secret indefinitely. It can also republish that retained `unattended:true` record through `pushHostedModelAuthToControlPlane`, undoing the revocation. Hosted snapshots need authoritative removals/tombstones (and hosted-node local cleanup) before this custody boundary is safe.

- **HIGH — A stale node can overwrite/reintroduce the entire hosted custody set.** `services/control-plane/src/index.ts:1902-1913` accepts a whole hosted vault from any enrolled node, and `services/control-plane/src/postgres-store.ts:1929-1934` unconditionally replaces both key and ciphertext without a generation/CAS or merge. Because each node builds a full filtered snapshot from local state (`src/server.ts:3743-3750`), an offline/stale node can race a revoke and restore the revoked credential, or erase newer grants/rotations. Hosted custody needs monotonic generation/conflict handling comparable to the ordinary model-auth vault.

- **HIGH — The rolling-upgrade response is incompatible with old nodes.** `services/control-plane/src/index.ts:1862-1878` returns the new filtered-vault key in the legacy `hostedKey` field alongside the ordinary `vault`. Pre-change nodes interpret `hostedKey` as the key for `vault`; a cold old node in a hosted-enabled account therefore caches the distinct filtered key, fails to decrypt the ordinary vault, deletes its cached key, and loops requesting a wrap. Capability negotiation or a separate versioned endpoint is required; rejecting old writes at `:1895-1897` does not make old reads safe.

- **HIGH — Browser/node convergence resurrects deleted API keys.** `packages/web/src/store/controller.ts:2509-2541` receives only live node entries/record summaries. If a key still exists in the PWA account vault but was deleted on the node while this device was offline, absence is indistinguishable from a browser-created key: the loop sends the stale key back with `credential.set`. No node tombstone/version is exported or compared. This defeats deletion/revocation on relay reconnect and also diverges from direct mode, which skips this convergence path. Export and merge item tombstones/versions before pushing browser-only entries.

No additional blocker was found in the assignment resolver itself or the item-addressed direct transport handlers.

## Validation

- `pnpm run typecheck` — passed
- `pnpm run typecheck:web` — passed
- `pnpm run lint` — passed with existing warnings (0 errors)
- Credential assignment/sync-policy tests — passed
- `@bivy/core` tests — 55 files / 650 tests passed
- Control-plane hosted escrow and device-vault tests — passed
