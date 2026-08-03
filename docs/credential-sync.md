# Credential and key sync model

Bivy has four different credential classes, each with its own sync behavior. They are not one generic "keys sync everywhere" feature.

## 1. Relay/session keys

Purpose: encrypt browser/PWA ↔ node session traffic over the hosted relay.

- Browser devices hold a non-extractable X25519 private key in IndexedDB when available.
- Nodes track paired device public keys in the local device registry.
- The room key is wrapped to paired devices; revoking a device rotates the room key and re-wraps it to survivors.
- The relay forwards opaque ciphertext and cannot decrypt session traffic.

## 2. Bivy-managed model/provider credentials

Purpose: let Bivy-native runtimes (Pi and compatible runtimes) use model API keys/OAuth records without sending plaintext to Bivy Cloud.

Current model:

- The node stores provider credentials in its local vault/Pi auth store.
- When hosted model-auth sync is enabled, the node encrypts a model-auth vault snapshot locally before uploading it to the control plane.
- The control plane stores ciphertext plus node public-key wrapping metadata.
- Another enrolled node requests a wrapped vault key; an existing node wraps the key to the requesting node public key.
- That request now **wakes the account's peer nodes over the relay** (the same `work.available` signal used for queued work), so a peer answers the wrapped-key request within seconds rather than on its 30s poll. The requesting node fast-retries (bounded) until the key lands, then falls back to the steady poll. This makes the vault — including supported subscription-OAuth logins — usable almost immediately on a short-lived ephemeral runner, while staying **peer-only**: the key is always wrapped node→node and never transits the device or control plane in the clear.
- Bivy Cloud never receives plaintext model credentials.

If you lose every node and device that can unwrap the vault, the stored
ciphertext can no longer be decrypted — sign in to each provider again on a new
node.

## 3. GitHub App private keys

Purpose: let a GitHub App connected on one node (`bivy github:app-connect` /
`github:app-create`) also serve the account's other nodes, without
re-uploading the `.pem` on each machine (issue #88).

Current model:

- Off by default, per node: `bivy github:app-sync on`. A GitHub App key is a
  repo-write credential, so widening which nodes hold it is a deliberate
  decision, not automatic like model/provider auth sync (above) — turning
  sync on bounds the blast radius to the nodes an operator explicitly opted
  in, rather than every node on the account.
- The node encrypts the app's private key (plus its non-secret slug/name/owner
  display metadata) into a per-APP vault entry before uploading it to the
  control plane — one vault per app, not one blob per account, because an
  account can hold several apps (personal + one per org) and they sync
  independently.
- The control plane stores ciphertext plus per-node wrapped vault-key metadata
  only, exactly like the model-auth vault — it never receives a plaintext app
  key.
- Another opted-in node requests a wrapped vault key for an app it doesn't
  hold yet; any node that already holds that app's key answers, wrapping it to
  the requester's public key.
- Revocation: when a node that held a wrapped key for an app is removed from
  the account, the control plane flags that app's vault for rotation. On its
  next sync tick, any surviving node that holds the app's plaintext key mints
  a BRAND NEW vault key and re-pushes — which is what actually invalidates the
  removed node's cached copy (it cached the old key while it was still
  trusted; the control plane can't reach into a device it no longer talks to
  and make it forget that). The already-installed GitHub App key itself is
  unchanged by this — only the transport-layer vault key that protects future
  syncs rotates. If the app key material itself may have been exposed,
  generate a fresh one on GitHub and reconnect (`github:app-connect --rotate-webhook`
  covers the webhook secret; the app's private key is rotated from GitHub's
  own app settings page).

## 4. Agent-native credentials

Purpose: credentials owned by a third-party CLI/runtime, e.g. Claude Code, Codex, Gemini CLI.

Examples:

- Claude Code CLI login/session files or keychain entries.
- Codex/OpenAI CLI auth files.
- Gemini CLI auth.

These are **not automatically synced across all nodes** unless Bivy explicitly imports and re-emits them as Bivy-managed credentials. Treat them as per-node native logins.

In short: Bivy syncs Bivy-managed provider credentials end-to-end for supported runtimes. Agent-native CLI logins may need to be performed once per node.

## Runtime mapping

| Runtime | Credential owner | Sync expectation |
| --- | --- | --- |
| Pi | Bivy/Pi | Eligible for Bivy-managed E2E sync |
| Claude Code SDK | Mixed | SDK may use Bivy/Pi auth; native Claude CLI handoff may need native login |
| Codex | Agent-native | Login per node unless imported later |
| Codex (approvals) | Agent-native | Login per node unless imported later |
| Gemini CLI | Agent-native | Login per node |
| Aider | Mixed | Depends on whether launched with Bivy-managed env/API key or native config |
| Generic CLI / OpenCode / Goose / OpenClaw | Agent-native | Per-node native configuration |

## Troubleshooting

- If a key may have been exposed, rotate it at the provider — never paste a provider key into a support channel.
- If a second node cannot use a model, check the table above to see whether that runtime uses Bivy-managed auth (which syncs) or agent-native auth (which needs a per-node login).
