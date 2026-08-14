# Bivy key management

> For a task-oriented guide to model-provider credentials — multiple accounts per
> provider, password-manager references, per-credential sync, and presets — see
> [credentials-guide.md](credentials-guide.md).

Bivy's credential boundary is that provider credentials stay on the node or in a vault you control. Bivy Cloud does not receive model API keys, GitHub repo tokens, OAuth refresh tokens, interactive session prompts, transcripts, or workspace files. Slack and generic webhook instructions have a separate, documented inbound-automation boundary; see [security-model.md](security-model.md#what-the-control-plane-sees).

## Current secret locations

| Secret | Default storage | Notes |
|---|---|---|
| GitHub repo/work-queue token | Bivy secret vault as `github.repo-token` | `cli.json` stores only `secret://github.repo-token`. |
| GitHub App private key | Bivy secret vault as `github.app.<appId>` | `github-apps.json` stores only a `secret://` reference. Opt-in E2E sync to the account's other nodes via `bivy github:app-sync on` — see [credential-sync.md](credential-sync.md#3-github-app-private-keys). |
| Integration API keys | Bivy secret vault as `integration.<id>.api-key` | `integrations.json` stores only a secret reference for new connections. |
| Integration OAuth token sets | Bivy secret vault as `integration.<id>.oauth` | Access/refresh token JSON is encrypted locally for new connections. |
| Model provider credentials | Pi auth store at `.bivy/pi/auth.json` | Shared with runtimes by Bivy's credential adapter. This is still Pi-owned. |
| Relay enrollment/node config | Local `.bivy/*.json` files, mode `0600` where supported | Used for outbound relay auth and device pairing. |
| Browser/PWA device keys | Browser storage/session storage depending on key | Do not treat the browser as a durable password manager. |

## Bivy secret vault

The node vault supports three forms:

1. **Encrypted local secret** — stored in `.bivy/secrets.json`, encrypted with AES-256-GCM. The local wrapping key is `.bivy/secrets.key` and both files are written `0600` where the OS supports chmod.
2. **1Password reference** — store only an `op://...` reference. Bivy resolves it with the `op` CLI at runtime; the raw secret is not stored by Bivy.
3. **Environment reference** — store only `env://NAME`. Bivy resolves the environment variable at runtime.

Commands:

```bash
bivy secrets list
bivy secrets set github.repo-token          # prompts, stores encrypted local value
bivy secrets ref github.repo-token op://Bivy/GitHub/token
bivy secrets ref model.anthropic env://ANTHROPIC_API_KEY
bivy secrets resolve github.repo-token      # verifies without printing the value
bivy secrets delete github.repo-token
bivy secrets doctor
```

## 1Password pattern

Use 1Password when you want sync, audit, recovery, and sharing policy:

```bash
op signin
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets ref model.anthropic op://Bivy/Anthropic/api-key
```

For process environment injection, put a secret reference in `.bivy/cli.json`:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "op://Bivy/Anthropic/api-key",
    "BIVY_GITHUB_TOKEN": "secret://github.repo-token"
  }
}
```

The `bivy` CLI resolves `secret://`, `op://`, and `env://` values before starting the daemon or runtime processes.

### Model-provider reference credentials (preferred over `cli.json` for model keys)

For a **model provider** key held in a password manager, prefer a *reference credential* over
the `cli.json` env mapping above. A reference stores only the pointer, which Bivy resolves per-node
at read time — the secret stays in the manager and never enters the vault — and it's a first-class
credential: labeled, selectable via presets, and shown in the Models screen. Add one from the PWA
(Keys & OAuth → Additional accounts) or the CLI. Three pointer schemes:

| Scheme | Resolves via | Notes |
| --- | --- | --- |
| `op://Vault/Item/field` | 1Password `op` CLI | syncs across your nodes (each resolves locally) |
| `env://NAME` | an environment variable | syncs; each node reads its own `NAME` |
| `cmd://<command>` | runs the command, uses its stdout | **any** password-manager CLI (Bitwarden, LastPass, Proton Pass, `pass`, gopass, …); **node-local, never synced** |

Examples: `cmd://bw get password anthropic`, `cmd://rbw get anthropic`, `cmd://pass show ai/anthropic`.

A node that can't resolve a reference (no `op` session, missing env var, a failing command) simply
reports no credential there — it never falls back to another account.

**`cmd://` runs an arbitrary command**, so it is deliberately kept **node-local and is never
synced** — a command that ran on every node would be cross-node code execution, and a manager CLI
is machine-specific anyway. Use `op://`/`env://` (or a synced Bivy-managed key) when you need the
credential on more than one node.

## Rotation and revocation

- Rotate GitHub tokens in GitHub, then update `github.repo-token`.
- Rotate a GitHub App's private key from the app's GitHub settings page, then reconnect it (`bivy github:app-connect --app-id <id> --key <new.pem>`) on a node that already holds it. If sync is on (`bivy github:app-sync on`), removing a node from the account flags that app's sync vault for rotation; the next opted-in node to sync mints a fresh vault key automatically (the removed node's cached copy of the OLD vault key stops decrypting anything pushed after that point).
- Rotate model API keys at the provider, then update the corresponding Pi login or environment/1Password reference.
- Removing an enrolled node automatically rotates the model-auth sync-vault key
  before later snapshots are distributed. Signing out of a Bivy-managed provider
  writes an encrypted tombstone so the deletion converges across enrolled nodes.
- Delete integration secrets with `bivy secrets delete integration.<id>.api-key` or disconnect the integration in the UI.
- Revoke a linked PWA/browser device from the app (Settings → Signed-in devices → remove); this rotates the room key and re-wraps it for the remaining devices. To force every device to re-link, remove them all (or reset pairing entirely: delete `.bivy/pairing.json` on the node and restart).

## Known limitations

- The default Pi and Claude Code integrations intentionally use each upstream agent's own credential/configuration store (`~/.pi/agent`, `~/.claude`). Bivy's encrypted vault remains available to integrations that explicitly opt into shared model credentials; it is not injected over an agent-owned login by default.
- The encrypted local vault protects against accidental plaintext sprawl, not against a fully compromised user account: the local wrapping key lives on the same machine.
- OS keychain backends are not yet implemented. Prefer 1Password references when you need synced/managed secrets.
