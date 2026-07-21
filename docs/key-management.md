# Bivy key management

Bivy's security boundary is that provider credentials stay on the node or in a vault you control. Bivy Cloud should not receive model API keys, GitHub repo tokens, OAuth refresh tokens, prompts, transcripts, or workspace files.

## Current secret locations

| Secret | Default storage | Notes |
|---|---|---|
| GitHub repo/work-queue token | Bivy secret vault as `github.repo-token` | `cli.json` stores only `secret://github.repo-token`. |
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

## Rotation and revocation

- Rotate GitHub tokens in GitHub, then update `github.repo-token`.
- Rotate model API keys at the provider, then update the corresponding Pi login or environment/1Password reference.
- Delete integration secrets with `bivy secrets delete integration.<id>.api-key` or disconnect the integration in the UI.
- Revoke a linked PWA/browser device from the app (Settings → Signed-in devices → remove); this rotates the room key and re-wraps it for the remaining devices. To force every device to re-link, remove them all (or reset pairing entirely: delete `.bivy/pairing.json` on the node and restart).

## Known limitations

- Model-provider credentials are still primarily Pi-owned in `.bivy/pi/auth.json`; Bivy can inject `op://`/`env://` values through process env, but Pi's own auth file has not been replaced by the Bivy vault.
- The encrypted local vault protects against accidental plaintext sprawl, not against a fully compromised user account: the local wrapping key lives on the same machine.
- OS keychain backends are not yet implemented. Prefer 1Password references when you need synced/managed secrets.
