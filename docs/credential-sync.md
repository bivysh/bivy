# Credential and key sync model

Bivy has three different credential classes. They should not be described as one generic "keys sync everywhere" feature.

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
- Bivy Cloud should never receive plaintext model credentials.

Production requirement before marketing this broadly:

- Add tests that prove the control-plane store only sees ciphertext/wrapped keys.
- Add a user-visible explanation of which providers/runtimes use Bivy-managed auth.
- Add a recovery story for losing all nodes/devices that can unwrap the vault.

## 3. Agent-native credentials

Purpose: credentials owned by a third-party CLI/runtime, e.g. Claude Code, Codex, Gemini CLI.

Examples:

- Claude Code CLI login/session files or keychain entries.
- Codex/OpenAI CLI auth files.
- Gemini CLI auth.

These are **not automatically synced across all nodes** unless Bivy explicitly imports and re-emits them as Bivy-managed credentials. Treat them as per-node native logins.

User-facing copy should say:

> Bivy can sync Bivy-managed provider credentials E2E for supported runtimes. Agent-native CLI logins may need to be performed once per node.

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

## Support guidance

- Never ask users to paste provider keys into support chat.
- If a key may have been exposed, rotate it at the provider.
- If a second node cannot use a model, first determine whether that runtime uses Bivy-managed auth or agent-native auth.
