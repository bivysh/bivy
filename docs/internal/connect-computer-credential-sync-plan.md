# Connect computer + key/OAuth sync — design & remediation plan

Phase 7 of the Make-Bivy-Great plan (`docs/internal/make-bivy-great-plan.md`). This
is the largest, most safety-sensitive surface — pairing/enrollment and provider
key/OAuth convergence across node ↔ device ↔ ephemeral runner — so, per that plan,
it gets its own design doc **before** implementation. This PR lands the doc plus
one scoped, pure, unit-tested fix (gap #4 below); the rest is sequenced here as
follow-ups, each self-contained.

Every claim carries a `file:line` anchor from a read of the current tree. Node
paths are repo-root-relative (`src/…`); control plane is `services/control-plane/src/…`.

The end-user credit model is already documented in `docs/credential-sync.md` (four
credential classes and their sync expectations). This doc is the *engineering*
companion: the exact code paths, the failure modes, and the convergence gaps.

---

## 1. Architecture map

### 1a. Connect computer = node enrollment (not device pairing)

"Connect this computer to the app" is **node enrollment** — a one-shot CLI
(`npm run relay:setup`), no QR:

1. Resolve endpoints + stable `NodeIdentity`, health-check the control plane
   (`src/relay-setup.ts:161-183`, `checkControlPlane` `73-84`).
2. Hands-free account sign-in → an account session token: GitHub device login
   (default, `relay-setup.ts:143-159`), email magic-link (`117-137`), or
   `--session-token`. `pollDevice` (`87-111`) polls until complete or throws on
   timeout/expiry (`107-110`).
3. `enrollNode()` → `POST /nodes/enroll` (`relay-setup.ts:186-192`; CP
   `index.ts:1124-1131`; store `postgres-store.ts:1000-1047`). Mints
   `enr_<base64url>`, stores only its **hash** (`1001-1002`), auto-disambiguates a
   colliding name (`1013`), enforces `maxNodes` → HTTP 402 (`1022-1024`), and
   `INSERT … ON CONFLICT (id) DO UPDATE` (`1029-1037`) so re-enroll is idempotent
   on `nodeId` but **rotates the enrollment token**.
4. Node-limit fallback: list + offer to replace a node (`relay-setup.ts:196-220`).
5. Persist `.bivy/relay.json` `{url, controlPlaneUrl, clientBaseUrl, enrollmentToken}`
   at 0600 (`relay-setup.ts:236-244`) — the node's long-lived bearer, verified per
   request by `requireNode`/`nodeFromEnrollmentToken` (`postgres-store.ts:1049-1056`).

### 1b. Device pairing (phone/PWA ↔ node) — the QR/room-key path

`pairing-crypto.ts` + `device-registry.ts`. Node mints an X25519 keypair + 32-byte
room key, refusing to regenerate a corrupt/partial `pairing.json`
(`device-registry.ts:118-133` — fails loud so it never silently invalidates paired
devices). The QR carries the node public key + a single-use `pairSecret`
(`pairing-crypto.ts:114`), **never** the room key. Handshake verifies
`HMAC(pairSecret, device_pub)` constant-time (`verifyPairingProof`
`pairing-crypto.ts:125-130`), then returns the room key wrapped under
`ECDH(node_priv, device_pub)` (`wrapRoomKey` `133-135`). Revoke rotates + re-wraps
to survivors (`device-registry.ts:277-293`).

### 1c. Provider key/OAuth vault + cross-node sync

- **Vault** (`credential-store.ts`): AES-256-GCM `auth.enc` under a once-minted
  0600 `auth.key`. Single write path `modify()` (`126-146`) — per-provider promise
  chain + cross-process mkdir lock, so an OAuth refresh can't be clobbered.
  Non-destructive merge `importAll` (`226-252`).
- **OAuth engine** (`oauth/model-oauth.ts`): login/refresh under the store lock,
  re-checking expiry (`346-357`); rotation-aware (`tokensFrom`). `anthropic` and
  `openai-codex` set `refreshRotates:true` (`model-oauth-providers.ts:67,86`).
- **Agent projection** (`credentials.ts`): refresh-on-read (`29-54`), creds → env
  (`buildAgentCredentialEnv 117-160`).
- **Cross-node** (`server.ts`): a fixed 32-byte account vault key (`4015-4021`),
  push (`4197-4227`) / pull (`4129-4182`) of a sealed envelope, peer-to-peer
  wrapped-key exchange (relay-woken, `4184-4195`). **Control plane stays blind** —
  only ciphertext + per-node wrapped keys (`index.ts:1593-1670`); escrow tested in
  `hosted-model-auth-escrow.test.ts` / `hosted-room-key-escrow.test.ts` /
  `device-vault.test.ts`.

---

## 2. Failure modes & convergence gaps (ranked)

1. **[HIGH — security] The model-auth vault key never rotates on node removal.**
   `removeNode` flags only `github_app_vaults` for rotation
   (`postgres-store.ts:1147-1153`); there is no `needs_rotation` on the model-auth
   vault, and the account key is minted once and reused (`server.ts:4015-4021`). A
   removed/compromised node keeps `model-auth-vault.json` and can decrypt every
   *future* provider-key/OAuth push. `docs/credential-sync.md:57-66` promises
   rotation-on-revoke for GitHub App keys but is silent for the more sensitive
   model-auth vault.
2. **[HIGH — convergence] Rotating refresh tokens dead-end other holders.** With
   `refreshRotates:true`, whichever surface refreshes first (node resolver, Codex
   CLI self-refresh `codex-auth.ts:20-25`, or an ephemeral) invalidates the refresh
   token every other holder has. Convergence relies on winner-push + loser-pull
   before the loser tries its dead token; until then a peer 400s on refresh.
3. **[MED-HIGH — convergence] Deletes / sign-out never propagate.** `importAll` is
   non-destructive and the envelope carries no tombstones (`server.ts:4032-4045`).
   Removing a provider pushes a snapshot that merely *omits* it; peers keep their
   copy, and the origin can even re-import it from a peer's stale snapshot.
4. **[MED — convergence] Clock skew can make a stale OAuth token win the merge.**
   `importAll` picked the winner purely by `expires` (`credential-store.ts`), which
   each node stamps with its own `Date.now()` (`model-oauth.ts` `tokensFrom`). A
   fast clock inflates `expires` and wins even when its token is actually older.
   **← fixed in this PR (§3).**
5. **[MED — convergence] A device-added key reaches only the attached node
   immediately**, and an already-running agent on a peer won't see it until
   relaunch (env injected at launch, `credential-provisioning.ts:45-48`; no live
   re-injection).
6. **[MED — availability] Ephemeral runners can decrypt a stale snapshot** (only as
   fresh as the last debounced peer push) and, if they then rotate-refresh, feed
   back into #2.
7. **[LOW-MED — wedge] Enrollment-token failures are swallowed** — an expired token
   401s every `requireNode` call; sync/heartbeat swallow it (`server.ts:4179-4181`)
   and the node silently detaches with no re-enroll prompt.

Pairing/enroll itself is largely robust: idempotent re-enroll, graceful node-limit
replace, loud refusal on a corrupt pairing file, single-use constant-time pairing
proof, and CP-blind escrow. Don't regress those.

---

## 3. Shipped in this PR — gap #4: monotonic, rotation-safe merge tiebreak

The cross-node merge decision is now a pure, exported, unit-tested function
`preferIncomingCredential(local, incoming)` (`credential-store.ts`), used by
`importAll`. It hardens three things over the old `expires`-only rule:

- **`refreshedAt` mint order beats `expires`.** OAuth mint points stamp
  `refreshedAt = Date.now()` when the token set is obtained (`model-oauth.ts`
  `tokensFrom`, carried into both the login and refresh writes). When both sides
  carry it, the later mint wins — a monotonic per-node signal that a skewed
  `expires` can't fake. Absent (pre-existing creds) → graceful fallback to
  `expires`.
- **Ties keep local.** Both the `refreshedAt` and the `expires` comparison are
  strictly-greater, so an equal stamp no longer clobbers/churns the vault (the old
  code let an equal-`expires` incoming overwrite).
- **A refresh-less snapshot never clobbers a usable refresh token.** Rotated
  refresh tokens are single-use; an incoming OAuth entry with a blank `refresh`
  string is strictly worse than a local one that still has it.

Non-OAuth cases (api-key set/replace, type switches) keep the prior "incoming wins
on a real content change". `+6` unit tests (`test/credential-merge.test.ts`).
Backward-compatible: old senders omit `refreshedAt`; the envelope already carries
whatever fields the credential has, so `refreshedAt` propagates for free.

---

## 4. Sequenced follow-ups (each self-contained)

- **Tombstone-aware merge (gap #3).** Add an optional `deletedAt` map to the sync
  envelope (`server.ts:4032-4045`) and let `importAll` honor a tombstone newer than
  the local credential's `refreshedAt`/`expires`. Pure merge extension; unit-testable
  with in-memory maps. Makes "sign out on this node" / revoke converge.
- **Rotate the model-auth vault key on node removal (gap #1).** Mirror the
  GitHub-App block: `needs_rotation` on `model_auth_vaults`, set in `removeNode`
  (`postgres-store.ts:1147-1153`), surfaced on `GET /node/model-auth-vault`, plus a
  pure `decideModelAuthRekey(...)` a surviving node consults to mint a fresh key +
  re-wrap only to current nodes. Land the store/endpoint plumbing + the pure
  decision (unit-tested like the escrow tests) first; gate the node re-key rollout
  behind it to bound risk.
- **Re-arm refresh before ephemeral snapshot use (gaps #2/#6).** After
  `importProviderAuth` on pull (`server.ts:4154`), call the existing
  `refreshExpiringOAuth` (`credential-provisioning.ts:31-38`) so a freshly-pulled
  near-expiry token is refreshed centrally (single-flight) before any agent
  consumes it, shrinking the stale-token window. Reuses existing locked machinery.
- **Surface a detached node (gap #7).** On a persistent 401 from `requireNode`,
  raise a node-level notice + a re-enroll affordance instead of silently detaching.

## 5. Verification note

The pairing/enroll and cross-node/escrow flows can't be exercised end-to-end
without a live control-plane ↔ relay ↔ device ↔ ephemeral setup, which this
environment lacks. The shipped fix is a **pure decision function** verified by unit
tests + typecheck; the follow-ups above are likewise scoped so their risky half is
a pure, unit-testable decision that lands before any live-only rollout.
