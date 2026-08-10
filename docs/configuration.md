# Configuration reference

Everything Bivy reads from the environment or from disk.

Sections are split by *where the setting takes effect*: the node on your
machine, the control plane, the relay, and the build/release tooling. Most
people only ever touch the node section — the control plane and relay are only
relevant if you self-host them.

Each entry marks whether it is **supported** user configuration or an
**escape hatch** (internal, experimental, or a knob that turns off a safety
control). Escape hatches can change or disappear without notice.

## Most people only need these

| Variable | What it does | Default |
| --- | --- | --- |
| `BIVY_WORKSPACE` | Default working directory for sessions | the Bivy install directory |
| `PORT` | Local port the node's API/WebSocket listens on | `4317` |
| `BIVY_SANDBOX` | How much the agent is allowed to do | `workspace-write` |
| `BIVY_APPROVAL_MODE` | Whether actions pause for your approval | `autonomous` |
| `BIVY_RUNTIME` | Default agent | `pi` |
| `BIVY_DATA_DIR` | Where Bivy keeps its state | see [Data directory](#data-directory) |
| `ANTHROPIC_API_KEY` | Anthropic model key, if you are not using OAuth | unset |
| `BIVY_HOST` | Bind address for the node's port | `127.0.0.1` |

`bivy setup` sets the workspace and port for you. The CLI and web Settings
screen write the canonical typed `<data-dir>/config.yaml`; see
[config-as-code.md](config-as-code.md). Environment variables remain useful for
deployment overrides and compatibility.

## Config files on disk

### Data directory

All mutable node state lives in one directory, resolved by `bin/bivy.mjs` in
this order:

1. `$BIVY_DATA_DIR`, if set (resolved to an absolute path).
2. `<install-dir>/.bivy`, if that directory already exists **or** the install
   is a git checkout (has `.git`). This covers dev checkouts and the
   `install.sh` tarball tree, which are user-owned and preserve `.bivy` across
   updates.
3. `~/.bivy` otherwise — the `npm i -g @bivy/bivy` / `npx @bivy/bivy` case, where the
   package directory may be root-owned and is replaced on update.

The CLI then **exports the resolved value as `BIVY_DATA_DIR`** into every child
process, so the daemon, agents and helper scripts all agree.

> Caveat: helper entry points that are launched *directly* rather than through
> the `bivy` CLI fall back to different defaults —
> `<install-dir>/.bivy` for most, `~/.bivy` for the git credential helper and the
> secret vault, and `$PWD/.bivy` for the standalone agent service. Set
> `BIVY_DATA_DIR` explicitly if you run those by hand.

### Files in the data directory

| Path | Contents | Written by |
| --- | --- | --- |
| `config.yaml` | **Canonical user-authored node configuration**: workspace/port, defaults, concurrency, session behavior, checks, and advanced environment references. Mode `0600` | `bivy setup`, `bivy config`, and the web Settings screen |
| `cli.json` | Generated compatibility projection: workspace, port, service state, and persisted environment. Do not hand-edit once `config.yaml` exists | Bivy CLI/config projection and integration connect flows |
| `settings.json` | Generated compatibility projection of node defaults for older binaries. Do not hand-edit once `config.yaml` exists | Node/config projection |
| `relay.json` | Relay URL, control-plane URL, client base URL, node enrollment token. Mode `0600` | `bivy relay:setup` |
| `nodes.json` | Direct-node registry (`name` → `{url, token}`) for `bivy run --node` | `bivy nodes add/remove` |
| `shims.json` | Installed agent shims | `bivy shim install/uninstall` |
| `plugins/<id>/manifest.json` | Canonical declarative plugin manifests; no executable code or secrets | `bivy plugin install/remove` |
| `secrets.json` / `secrets.key` | AES-256-GCM encrypted secret vault and its key. Both `0600` | `bivy secrets`, `bivy voice`, GitHub connect flows |
| `bootstrap.json` | Per-process bootstrap secret the CLI uses to mint a device token | The node at startup |
| `node.json` | Stable node identity (id, name) | The node |
| `pairing.json` | Paired remote devices | The node |
| `metadata.json` | Cross-agent session index | The node |
| `integrations.json` | Connected third-party integrations | The node |
| `credentials/` | Shared, agent-neutral model credential vault (`auth.enc`, `auth.key`) | `bivy login`, the web app |
| `pi/` | Pi's own config, `models.json` projection, and sessions | Pi |
| `event-log/`, `transcripts/`, `intermediate-messages/`, `tool-activities/` | Session history | The node |
| `repos/` | Checkouts for repo-backed sessions | The node |
| `workspaces/` | Ephemeral `bivy run --clone` checkouts | The CLI |
| `dep-cache/` | Shared package-manager cache, when enabled | The node |
| `git-cred/` | Git credential helper materialised on disk | The node |
| `node.log`, `update.log` | Background start / update logs | The CLI |

### `config.yaml`

The supported file format, CLI editor, migration behavior, repository
`.bivy/policy.yaml`, and examples are documented in
[config-as-code.md](config-as-code.md).

### `cli.json` compatibility projection

```json
{
  "workspace": "/home/you/bivy-workspace",
  "port": 4317,
  "service": true,
  "env": {
    "BIVY_RUNTIME": "claude-code-sdk",
    "BIVY_GITHUB_TOKEN": "secret://github.repo-token"
  }
}
```

The `env` block is retained as a generated compatibility projection. Put
advanced overrides in `config.yaml`'s typed fields or `environment` block; Bivy
projects them here for older binaries. Two things consume the projection:

- **The CLI**, when starting the daemon or generating a service unit: it
  resolves `secret://`, `env://` and `op://` references to real values first,
  so a service unit never contains a plaintext token.
- **The daemon itself**, at boot. It reads `cli.json` and copies each string
  value into `process.env` — but **only for keys that are not already set**. A
  projected config change therefore survives a restart even when the generated
  service unit's baked-in environment is stale.

The value `""` deletes a key when the node writes `cli.json`.

## Precedence

For a variable's raw value:

1. Real process environment (your shell, or the generated systemd/launchd unit).
2. `config.yaml`'s typed field or `environment` block.
3. `cli.json`'s generated `env` compatibility projection, for keys not already set.

`BIVY_DATA_DIR` and `BIVY_ASSET_ROOT` are read before the `cli.json` merge, so
they cannot be set from `cli.json`.

For settings that also have legacy projections:

| Setting | Precedence |
| --- | --- |
| Sandbox tier | per-session/automation request → `BIVY_SANDBOX`/`config.yaml` default → node `safety.maxSandbox` ceiling → repository safety ceiling (the most restrictive bound wins) |
| Approval mode | per-session/automation request → `BIVY_APPROVAL_MODE`/`config.yaml` default → node `safety.approvalFloor` → repository approval floor (the most restrictive bound wins) |
| Default agent | per-run override → `BIVY_RUNTIME` → `config.yaml` `defaults.agent` → `pi` |
| Auto-attach tool images | `BIVY_AUTO_ATTACH_TOOL_IMAGES` → `config.yaml` `sessions.autoAttachToolImages` → off |
| Wedged-turn recovery | `config.yaml` `sessions.wedgedTurnMinutes` → `BIVY_TURN_ACTIVITY_STALL_MS` → 15 min. A turn that keeps streaming raw tool output but makes no structural progress (no tool completion, model text, or turn boundary) for this long is recovered. `0` disables it, leaving the 5-min silence stall and 1-hour cap. |

CLI flags always win over both, for the commands that have them
(`bivy exec --agent`, `bivy relay:setup --control-plane`, `bivy prune
--data-dir`, and so on).

### How values are parsed

Value parsing is not uniform across variables:

- Strict `"1"` booleans (nothing else counts): `BIVY_ALLOW_ANY_ORIGIN`,
  `BIVY_OPEN_BOOTSTRAP`, `BIVY_GITHUB_TASKS`, `BIVY_GITHUB_HOSTED_TASKS`,
  `BIVY_SKIP_AGENT_PREINSTALL`.
- Tri-state overrides (`"1"` forces on, `"0"` forces off, unset auto-detects):
  `BIVY_REQUIRE_LOCAL_AUTH`, `BIVY_MULTI_USER_HOST`.
- Plain truthiness (**any** non-empty value enables, including `"0"` and
  `"false"`): `BIVY_EGRESS_PROXY`, `BIVY_MCP_PROXY`, `BIVY_WORKTREE_COW_CLONE`,
  `BIVY_DEBUG`, `BIVY_AUTO_ATTACH_TOOL_IMAGES`.
- Numeric knobs that honour `0` as "off/zero": `BIVY_SESSION_IDLE_CLOSE_MS`,
  `BIVY_MAX_OPEN_SESSIONS`, `BIVY_MAX_RUN_TERMINALS`,
  `BIVY_WORKTREE_RETENTION_MS`, `BIVY_WORKTREE_SOFT_CAP_BYTES`,
  `BIVY_MIN_FREE_DISK_BYTES`, `BIVY_SHARED_DEP_CACHE_MAX_BYTES`,
  `BIVY_UPDATE_WAIT_TIMEOUT_MS`.
- Numeric knobs where `0` means "use the default": `BIVY_RUN_IDLE_NOTIFY_MS`,
  `BIVY_TERM_BELL_QUIET_MS`, `BIVY_TERM_BELL_COOLDOWN_MS`,
  `BIVY_EXEC_TIMEOUT_MS`, `BIVY_GITHUB_POLL_MS`.

---

# Node (your machine)

Changing any of these requires a node restart (`bivy restart`, or `bivy start`)
unless noted.

## Paths and workspace

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_DATA_DIR` | path | see [Data directory](#data-directory) | Supported | All writable node state. Exported to children by the CLI |
| `BIVY_WORKSPACE` | path | the Bivy install directory | Supported | Default cwd for sessions. `bivy setup` writes `~/bivy-workspace` into `cli.json` instead, which the CLI passes through as this variable |
| `BIVY_REPOS_DIR` | path | `<data-dir>/repos` | Supported | Where repo-backed sessions clone GitHub repos, one checkout per repo |
| `BIVY_ASSET_ROOT` | path | the install directory | Escape hatch (packaging) | Read-only bundled assets. Set by packaged builds so the app bundle can stay read-only |

## Networking and local auth

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | integer | `4317` | Supported | Node HTTP/WebSocket port. `bivy setup` auto-picks the first **free** port at or above `4317`, so a second node on the same machine (staging + production, or one node per OS user) lands on `4318`, `4319`, … without you choosing. Set `PORT` explicitly to override; the daemon exits with a clear error if its port is already taken |
| `BIVY_HOST` | address | `127.0.0.1` | Supported | Bind address. `HOST` is accepted as a fallback. **This port grants full control of the node with no TLS** — only widen it on a network you trust |
| `HOST` | address | — | Supported | Second choice for `BIVY_HOST` |
| `BIVY_PUBLIC_URL` | URL | request-derived, else `http://localhost:<port>` | Supported | External base URL used to build integration OAuth redirect URIs. Set this behind a reverse proxy |
| `BIVY_REQUIRE_LOCAL_AUTH` | `1` \| `0` | unset (auto) | Supported (hardening) | By default a loopback caller is authorized without a token, *unless* the host looks multi-user (see `BIVY_MULTI_USER_HOST`), in which case a device token is required. `1` always requires a token even on `127.0.0.1`; `0` always allows the loopback bypass |
| `BIVY_MULTI_USER_HOST` | `1` \| `0` | unset (auto-detect) | Supported (hardening) | Overrides the auto-detection `BIVY_REQUIRE_LOCAL_AUTH` uses to decide whether loopback needs a token. Detection reads `/etc/passwd` (Linux) or `dscl` (macOS) for more than one human account; not implemented on Windows. Set this if detection is wrong for your box |
| `BIVY_ALLOWED_HOSTS` | comma list | empty | Supported | Extra hostnames accepted in `Host`/`Origin`, e.g. a reverse-proxy domain. Only local/private hostnames are accepted otherwise |
| `BIVY_ALLOW_ANY_ORIGIN` | `1` | unset | **Escape hatch** | Disables the DNS-rebinding and cross-site guard entirely. Any web page you visit could then drive your agent |
| `BIVY_OPEN_BOOTSTRAP` | `1` | unset | **Escape hatch** | Accepts any bootstrap request on loopback without the per-process bootstrap secret |

## Safety: sandbox and approvals

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_SANDBOX` | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` | Supported | Selects the tier each agent enforces in its own native sandbox (Codex `--sandbox`, Gemini `--approval-mode`, Claude `permissionMode`). Agents with no native sandbox (Goose, OpenCode, Aider) are governed by Bivy's filesystem/MCP/network channels instead. Case-insensitive; `_` is normalised to `-`; an unrecognised value is silently ignored |
| `BIVY_APPROVAL_MODE` | `autonomous` \| `risky` \| `always` \| `never` | `autonomous` | Supported | Controls prompting where the selected runtime exposes structured tool calls. On those paths, heuristic catastrophic-command/workspace checks apply and backstop actions pause. Process runtimes without interception still run with the OS user's permissions; this setting is not an isolation boundary |
| `BIVY_EGRESS_PROXY` | any non-empty | unset | Supported (opt-in) | Routes CLI-agent outbound traffic through a local governance broker, whose proxy env is merged into every agent subprocess |
| `BIVY_MCP_PROXY` | any non-empty | unset | Supported (opt-in) | Rewrites the agent's on-disk MCP config so its servers launch through `bivy mcp-proxy`, restored on session close. Skipped for Pi and the Claude SDK, which govern MCP natively. Note: `BIVY_MCP_PROXY=0` **enables** it |

The Bivy-owned OS jail (bubblewrap / `sandbox-exec`) was removed for v1.0.
`BIVY_EXEC_JAIL` and `BIVY_EXEC_JAIL_READS` no longer exist.

## Agent selection

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_RUNTIME` | agent id | `pi` | Supported | Default agent. Built-in and installed plugin-agent ids are accepted. Lowercased |
| `BIVY_PLUGIN_DIR` | path | `<data-dir>/plugins` | Supported (advanced) | Override the node-local declarative plugin store; primarily for managed deployments and testing |
| `BIVY_CLAUDE_MODEL` | model id | unset | Supported | Default model for the Claude Code SDK runtime |
| `BIVY_CLAUDE_SESSIONS_DIR` | path | unset | Supported | Extra directory to search for Claude Code transcripts |
| `BIVY_PI_CLI` | path | the bundled `@earendil-works/pi-coding-agent` CLI | Escape hatch (packaging) | Path to the Pi CLI entry point |

### Per-agent overrides

These apply to the CLI-driven agents: `codex`, `opencode`, `aider`, `hermes`,
`goose`, `gemini`, `qwen`, `cline`, `crush`. Substitute the uppercased id —
`BIVY_CLINE_ARGS`, `BIVY_GEMINI_MODELS`, `BIVY_CRUSH_RESUME_TEMPLATE`, and so on.

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_<ID>_ARGS` | JSON string array | the built-in spec's args | Supported | Corrects a CLI's flags for a version Bivy hasn't pinned. Malformed JSON is ignored |
| `BIVY_<ID>_RESUME_TEMPLATE` | JSON string array | the spec's template, if any | Supported | Resume args. `{id}`, `{tier}` and a whole-token `{sandbox}` are substituted |
| `BIVY_<ID>_MODELS` | JSON array of `{id,name?,provider?}` (or bare strings) | the spec's curated list | Supported | Selectable models |
| `BIVY_<ID>_THINKING` | JSON `{levels[],template[],insertAt?,default?}` | the spec's setting | Supported (advanced) | Reasoning-effort flags. Requires both `levels` and `template` or it is ignored |

### Named custom agents

`BIVY_CUSTOM_AGENTS` registers reusable agents in both the web picker and
`bivy run`. Its value is a JSON array. Each entry requires a unique lowercase
`id` and an `extends` value naming a built-in CLI agent; it may override
`label`, `command`, `args`, `jsonArgs`, `parserId`, `promptMode`, and `hidden`.
Custom agents inherit the base agent's execution behavior and always appear as
experimental/unverified. Invalid entries are ignored without affecting built-ins.

```sh
export BIVY_CUSTOM_AGENTS='[{"id":"company-codex","label":"Company Codex","extends":"codex","command":"company-codex","args":["exec"]}]'
```

Persist the same value in `cli.json`'s `env` object to make it available to the
daemon and terminal CLI after restart.

Codex resume is special-cased and does **not** use the generic path:

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_CODEX_RESUME_TEMPLATE` | JSON string array with `{id}`/`{tier}` | `codex exec --json --sandbox <tier> resume <id>` | Supported |
| `BIVY_CODEX_BIN` | command or path | `codex` | Escape hatch — only used for the session-naming subprocess, and by the Codex app-server shim |

OpenClaw:

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_OPENCLAW_COMMAND` | command | `openclaw` | Supported |
| `BIVY_OPENCLAW_ARGS` | JSON array or quoted shell string | `["agent","--message"]` | Supported |
| `BIVY_OPENCLAW_AGENT` | string | unset | Supported — splices `--agent <name>` before `--message` |

### Running an arbitrary CLI agent (`generic-cli`)

Setting `BIVY_AGENT_COMMAND` enables a universal runtime that pipes any CLI.
This is a documented escape hatch: it gives streaming but not structured
approvals unless the agent speaks the Bivy protocol.

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_AGENT_COMMAND` | command | unset (runtime disabled) | Supported escape hatch |
| `BIVY_AGENT_ARGS` | JSON array, or a quote-aware shell split | `[]` | Supported |
| `BIVY_AGENT_ID` | string | `generic-cli` | Supported |
| `BIVY_AGENT_NAME` | string | `Generic CLI Agent` | Supported |
| `BIVY_AGENT_PROMPT_MODE` | `argv` \| anything else | `stdin` | Supported |
| `BIVY_AGENT_RESUME_TEMPLATE` | JSON string array with `{id}` | unset (fresh process per prompt) | Supported |
| `BIVY_AGENT_PARSER` | `claude-stream-json` \| `codex-json` \| `goose-stream-json` \| `gemini-json` | the agent spec's parser | Supported (advanced). An unknown id means raw passthrough |
| `BIVY_AGENT_STRUCTURED` | `0` disables | on, whenever the agent has a parser | Supported (compat) |
| `BIVY_TOOL_TRACE_FILE` | absolute path | unset | Diagnostic, explicit opt-in | Appends bounded JSONL call/result payloads for normalization-fixture curation. May contain code, paths, and commands; never enable on sensitive sessions or commit raw traces |

### Bivy Agent Protocol (`bivy-agent-protocol`)

A stdio/JSONL protocol runtime.

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_PROTOCOL_COMMAND` | command | unset (runtime disabled) | Supported escape hatch |
| `BIVY_PROTOCOL_ARGS` | JSON array or quoted shell string | `[]` | Supported |
| `BIVY_PROTOCOL_NAME` | string | `Bivy Protocol Agent` | Supported |
| `BIVY_PROTOCOL_COMMANDS` | JSON array of `{name,description}` | unset | Supported — seeds slash-command autocomplete before the agent's first handshake |

## Model credentials

Prefer `bivy login` (which stores credentials encrypted in
`<data-dir>/credentials`) or the agent's own CLI login. These environment
variables are a fallback.

| Variable | Type | Status | Notes |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | key | Supported | Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | token | Supported | Claude Pro/Max subscription bearer. **Takes precedence over `ANTHROPIC_API_KEY`** |
| `CLAUDE_CONFIG_DIR` | path | Supported | *Additional* search root for Claude Code transcripts and credentials. `~/.claude` is always searched too |
| `OPENAI_API_KEY` | key | Supported | Used by Codex, and as the OpenAI speech-to-text fallback. If set, Bivy will **not** mint a `CODEX_HOME/auth.json` — the key wins |
| `CODEX_HOME` | path | Supported | Codex CLI home (`auth.json`, rollouts). Default `~/.codex`. Bivy also sets it for child processes after minting auth from its vault |
| `GROQ_API_KEY` | key | Supported | Groq speech-to-text fallback when no key is in the vault. Groq is the default STT provider |
| `PI_OAUTH_CALLBACK_HOST` | address | Supported / internal | Bind host for the local OAuth callback listener. `127.0.0.1` standalone, but the daemon force-defaults it to `::` so `localhost` resolves either way |

Speech-to-text keys are normally stored per-node with `bivy voice key <provider>`
or the web app's Settings → Voice input; the env vars above are only consulted
when no stored key exists.

## Integrations

Third-party integrations need an OAuth client you register yourself. Without
the client id the integration reports "not configured".

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_GOOGLE_CLIENT_ID` / `BIVY_GOOGLE_CLIENT_SECRET` | string | unset | Supported (operator config) — Google/Gmail |
| `BIVY_DROPBOX_CLIENT_ID` / `BIVY_DROPBOX_CLIENT_SECRET` | string | unset | Supported (operator config) — Dropbox |

Notion and GitHub integrations use tokens, not an OAuth client, and need no env
vars.

## Remote access (relay and control plane)

The hosted endpoints all derive from one domain, so you normally set nothing.

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_HOSTED_DOMAIN` | domain | `bivy.sh` | Supported — re-points all three derived URLs at once (self-host/staging) |
| `BIVY_CONTROL_PLANE_URL` | URL | `https://app.<domain>` | Supported. Setting this (or `BIVY_RELAY_URL`) makes `bivy setup` default the remote-access prompt to **self-hosted** and pre-fills this URL |
| `BIVY_RELAY_URL` | `ws(s)://` URL | `wss://relay.<domain>` | Supported. **Overrides the value in `relay.json`**. Setting this (or `BIVY_CONTROL_PLANE_URL`) makes `bivy setup` default to **self-hosted** and pre-fills this URL |
| `BIVY_CLIENT_BASE_URL` | URL | the resolved control-plane URL | Supported — where the web app is served |
| `BIVY_RELAY_TOKEN` | token | `relay.json`'s `enrollmentToken` | Supported. If neither a URL nor a token resolves, the relay stays off |
| `BIVY_EMAIL` | email | unset | Supported — non-interactive `bivy relay:setup` |
| `BIVY_SESSION_TOKEN` | token | unset | Supported — skip sign-in during `relay:setup` with an existing account session |
| `BIVY_AUTH` | `github` | unset | Supported — force GitHub sign-in. GitHub is used anyway when neither an email nor a session token is given |
| `BIVY_NODE_LABEL` | label | unset | Supported override — an **extra** work-queue label this node serves, on top of `<base>` and `<base>/<node-name>`. Accepts `bivy/x` or a bare `x`. Rarely needed; the node name is used automatically |
| `BIVY_URL` | URL | `http://localhost:<PORT>` | Supported — which node the `bivy exec` / attach clients talk to. `--url` wins |
| `BIVY_DEVICE_TOKEN` | token | unset | Supported — bearer for those clients. `--token` wins |
| `BIVY_UPDATE_REGISTRY_URL` | URL | `https://registry.npmjs.org/%40bivy%2Fbivy/latest` | Supported — registry endpoint the node polls for update notices. Point at a mirror or private registry |
| `BIVY_MODEL_CATALOG_URL` | URL | `https://bivy.sh/api/models/local-catalog.json` | Supported — remote local-model presets. Fetched best-effort with a 2.5 s timeout; failure is silent |

## GitHub work queue

Two paths exist. The **hosted** path (a GitHub App connected through the control
plane) is the supported one; the **direct** path (a PAT polling GitHub) is for
self-contained setups.

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_GITHUB_TASKS` | `1` | unset | Supported | Opt in to issue pickup. Also implied when both a token and a repo are set |
| `BIVY_GITHUB_HOSTED_TASKS` | `1` | unset | Supported (usually auto-set) | Poll the hosted control-plane queue instead of GitHub directly. Written for you when you connect a GitHub App |
| `BIVY_GITHUB_TOKEN` | token or `secret://`/`op://`/`env://` ref | falls back to `gh auth token` | Supported | Prefer the reference form. `bivy github:connect` stores the token in the vault and writes `secret://github.repo-token` here. Legacy inline tokens are migrated into the vault automatically |
| `BIVY_GITHUB_REPO` | `owner/repo` | inferred from the checkout | Supported | |
| `BIVY_GITHUB_REPO_DIR` | path | `$BIVY_WORKSPACE`, else the cwd | Supported | Checkout used for repo inference and git operations |
| `BIVY_GITHUB_LABEL` | label | `bivy` | Supported | Base issue label, and the prefix for node-scoped labels |
| `BIVY_GITHUB_CLAIM_LABEL` | label | `bivy:in-progress` | Supported | Applied to claim an issue |
| `BIVY_GITHUB_POLL_MS` | integer ms | `60000`, floored at `10000` | Supported | |
| `BIVY_GITHUB_APP_ID` | string | unset | Supported (written by the connect flow) | Presence alone implies the hosted queue |
| `BIVY_GITHUB_APP_PRIVATE_KEY` | `secret://`/`op://`/`env://` ref, or an inline PEM | `secret://github.app-private-key` | Supported | |
| `BIVY_GITHUB_OAUTH_CLIENT_ID` | string | unset | Supported (deployment config) | Public OAuth client id for the `bivy github:connect` device flow. Unset means the device flow is unavailable |
| `BIVY_GITHUB_APP_SLUG` | string | — | Internal | Written by Bivy after registering app metadata; never read as input |

## Resource limits and disk

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_MAX_OPEN_SESSIONS` | integer | `100` | Supported | `0` disables the cap. Over the cap, the least-recently-used idle session is detached and persisted, not destroyed |
| `BIVY_MAX_RUN_TERMINALS` | integer | `50` | Supported | `0` disables. Over the cap, new run-terminals are rejected — never killed |
| `BIVY_SESSION_IDLE_CLOSE_MS` | integer ms | `1800000` (30 min) | Supported | |
| `BIVY_WORKTREE_RETENTION_MS` | integer ms | `604800000` (7 days) | Supported | Sweep interval is derived and clamped to 1–24 h |
| `BIVY_WORKTREE_SOFT_CAP_BYTES` | integer bytes | `0` (off) | Supported (opt-in) | **Advisory only** — logs oversized worktrees, never deletes |
| `BIVY_MIN_FREE_DISK_BYTES` | integer bytes | `0` (off) | Supported (opt-in) | Refuses new disk-consuming work below this free-space threshold. An unmeasurable filesystem always admits |
| `BIVY_WORKTREE_COW_CLONE` | any non-empty | unset | Supported (opt-in, experimental) | Copy-on-write cloning of installed dirs (`node_modules` etc.) from a sibling worktree. Requires filesystem CoW support; silently disabled otherwise |
| `BIVY_SHARED_DEP_CACHE` | `1`/`true`, **or a path** | unset | Supported (opt-in) | Points npm/yarn/pip/cargo/go *caches* at one directory for every agent and terminal. `1`/`true` uses `<data-dir>/dep-cache`; any other value is taken as an explicit path. Cache-only — never changes a project's lockfile or install location |
| `BIVY_SHARED_DEP_CACHE_MAX_BYTES` | integer bytes | `21474836480` (20 GiB) | Supported | LRU eviction cap for the shared cache. `0` disables eviction |
| `BIVY_ATTACHMENT_MAX_FILE_BYTES` | integer bytes | `26214400` (25 MiB) | Supported | Node-side hard limit for a durably stored attachment; composer uploads have a stricter 10 MiB limit |
| `BIVY_ATTACHMENT_STORE_MAX_BYTES` | integer bytes | `2147483648` (2 GiB) | Supported | Global admission cap for new blobs. GC removes only unreferenced blobs; if a lowered cap is already exceeded by referenced history, it is retained and an over-cap warning is reported |
| `BIVY_ATTACHMENT_RETENTION_MS` | integer ms | `2592000000` (30 days) | Supported | Minimum age before an unreferenced attachment is collected during the disk sweep |

## Terminals and notifications

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_EXEC_TIMEOUT_MS` | integer ms | `600000` (10 min) | Supported — `bivy exec` client wait timeout. `--timeout <seconds>` wins |
| `BIVY_TURN_TIMEOUT_MS` | integer ms | `3600000` (60 min) | Supported — daemon-side watchdog for every agent turn. Stops the runtime, marks the session timed out, and releases ephemeral/queue progress. `0` explicitly disables it; values above 24 h are capped |
| `BIVY_AUTOMATION_CHECKS` | JSON array or comma list of package-script names | `test,lint,typecheck` | Supported | Deterministic checks run after unattended issue work when those scripts exist. Only name/hash/status/exit are reported; command text/output stay on the node |
| `BIVY_AUTOMATION_CHECK_TIMEOUT_MS` | integer ms | `600000` (10 min) | Supported | Per-check timeout, clamped to 1 s–30 min |
| `BIVY_RUN_IDLE_NOTIFY_MS` | integer ms | `30000` | Internal / test tuning |
| `BIVY_TERM_BELL_QUIET_MS` | integer ms | `8000` | Internal / test tuning — how long since your last keystroke before a terminal bell counts as "you stepped away" |
| `BIVY_TERM_BELL_COOLDOWN_MS` | integer ms | `45000` | Internal / test tuning — collapses a bell storm into one notification |
| `BIVY_MCP_ENDPOINT` | URL | `http://127.0.0.1:4317` | Internal — the daemon sets it to its real port for `bivy mcp-proxy` children |
| `BIVY_MCP_SESSION` | session id | `""` | Internal — set by Bivy when spawning the MCP proxy |
| `BIVY_TERMINAL` | `1` | — | Internal marker. Bivy sets it in every PTY so shells (and `bivy update`) can tell they are inside Bivy. Never read as input by the node |

Standard OS variables are also honoured: `PATH`, `SHELL` (default `/bin/bash`),
`HOME`, `COMSPEC` and `PATHEXT` (Windows), and `LC_ALL`/`LC_CTYPE`/`LANG`. If
none of the three locale variables is set, PTY children get
`LANG=en_US.UTF-8` and `LC_CTYPE=en_US.UTF-8`.

## Remote agent runtime (experimental)

Runs agents in a separate `agent-service` process instead of in the daemon.
Off by default and inert — the in-process path is unchanged when it is off.

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_REMOTE_RUNTIME` | `1`/`true`/`all`/`*`, or a comma list of runtime ids | unset | **Experimental** |
| `BIVY_REMOTE_RUNTIME_ADDR` | `unix:<path>` or `host:port` | unset | **Experimental** — without it, the flag does nothing |
| `BIVY_AGENT_SERVICE_LISTEN` | `unix:<path>` or a bare port | **required** by `agent-service`; it exits with status 2 without it | Supported for that process |
| `BIVY_REMOTE_RUNTIME_DETACH_REAP_MS` | integer ms | `0` (off) | **Experimental** — reap detached idle sessions |

## CLI and packaging

| Variable | Type | Default | Status | Notes |
| --- | --- | --- | --- | --- |
| `BIVY_NPM_GLOBAL_PREFIX` | path | `~/.local` | Supported | Prefix for user-scoped global agent installs. `<prefix>/bin` is prepended to `PATH` for every agent and terminal child |
| `BIVY_SKIP_AGENT_PREINSTALL` | `1` | unset | Supported | Skip installing bundled agents during setup/update. Useful in CI or offline |
| `BIVY_UPDATE_WAIT_TIMEOUT_MS` | integer ms | `1800000` (30 min) | Supported | How long `bivy update`/`bivy restart` waits for busy sessions. `0` skips waiting |
| `BIVY_SHIM_DISABLE` | `1`, or an agent name | unset | Supported | Bypass an installed agent shim for one invocation: `BIVY_SHIM_DISABLE=1 claude` |
| `BIVY_DEBUG` | any non-empty | unset | Supported | Print stack traces from the CLI |
| `BIVY_AGENT_<NAME>_COMMAND` / `BIVY_AGENT_<NAME>_ARGS` | command / JSON array | unset | Supported | Teaches `bivy run <name>` about an agent the CLI does not know. `<NAME>` is the agent id uppercased with non-alphanumerics replaced by `_`. A malformed `_ARGS` value is a hard error |
| `BIVY_TSX` | path | the bundled `tsx` CLI | Escape hatch (packaging) | **Setting it to the empty string is meaningful** — packaged builds do that to drop `tsx` entirely |
| `BIVY_NATIVE_PI` | path | `<asset-root>/src/native-pi.ts` | Escape hatch (packaging) | |
| `BIVY_PTY_RUNNER` | path | `<asset-root>/src/pty-runner.py`, else `dist/pty-runner.py` | Escape hatch (packaging) | |
| `PYTHON` | command | `python3` | Supported | Interpreter for the PTY runner |
| `BIVY_UPDATE_DETACHED` | `1` | unset | Internal | Re-exec marker set by `bivy update` when it detaches from a Bivy terminal |
| `BIVY_CODEX_APPROVAL_POLICY` | Codex policy string | `untrusted` | Internal | Read by the Codex app-server shim; set by Bivy when spawning it |
| `BIVY_CODEX_SANDBOX` | Codex sandbox mode | `workspace-write` | Internal | Same |

Secret references (`secret://`, `env://`, `op://`) can be used as the value of
any variable in `cli.json`'s `env` block, and `env://NAME` resolves to
`process.env.NAME` — so arbitrary variable names are reachable through the
vault.

---

# Control plane (self-host only)

Only relevant if you run your own control plane (`services/control-plane`).
See `docs/self-host.md` for the deployment path; `deploy/self-host.sh` generates
a `.env` with sensible values.

**Set `NODE_ENV=production`.** It is the master switch for every production
guard below; without it the service starts with a well-known shared secret and
unauthenticated dev login enabled.

## Required in production

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | string | unset | Only `production` is special. Enables the boot-time config assertions |
| `DATABASE_URL` | Postgres URL | unset → an **in-memory** `pg-mem` store, wiped on every restart | Required in production; the service exits 1 without it |
| `RELAY_SECRET` | opaque string | **`dev-relay-secret`** | Shared secret for the relay's introspection calls. Required in production and must not be the default, or the service exits 1. Generate with `openssl rand -hex 32` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | none | Required in production **if** `STRIPE_SECRET_KEY` is set; otherwise the service exits 1 |
| `RESEND_API_KEY` | `re_…` | none | Required in production for magic-link email — but only checked when a magic link is first requested, not at boot |

## Core

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | integer | `4400` | |
| `PUBLIC_CONTROL_PLANE_URL` | URL | derived from `x-forwarded-proto` / `x-forwarded-host` / `Host` | Canonical external base URL, used for OAuth redirect URIs and magic-link URLs. **Set this** — the header-derived fallback trusts unvalidated proxy headers |
| `RELAY_PUBLIC_URL` | `ws(s)://` URL | `ws://localhost:4500` | Public relay URL handed to nodes and clients in relay tickets |
| `RELAY_SHARD_URLS` | comma-separated URLs | falls back to `RELAY_PUBLIC_URL`, then `ws://localhost:4500` | Node→shard mapping is by hash of the node id |
| `DATABASE_POOL_MAX` | integer ≥ 1 | `10` | |
| `LINK_GRANT_TTL_MS` | integer ms | `2592000000` (30 days) | TTL of the device-linking grant minted from a pairing QR |
| `ENFORCE_ENTITLEMENTS` | `1` | **off without Stripe; always on with Stripe** | Stripe-backed hosted deployments always enforce plan gates, regardless of this flag. On Bivy Cloud, free accounts may surface `TRIAL_SESSIONS` (25 by default) distinct sessions through the hosted app and get `FREE_WEEKLY_RUNS` (10) unattended automations per rolling 7-day window, with one grace job before refusal. Local execution/history remains on the node when the hosted-view trial is exhausted. Paid plans omit both limits. On no-billing/self-hosted stacks enforcement remains off and all features are unlimited. |
| `TRIAL_SESSIONS` | positive integer | `25` | Lifetime number of distinct sessions a free Bivy Cloud account may view through the hosted app. Ignored when entitlement enforcement is off. |
| `RUN_LIMIT_OBSERVE_ONLY` | `1` | **off** | Observe-only mode for no-billing test/staging deployments with `ENFORCE_ENTITLEMENTS=1`. It is ignored when Stripe billing is configured, where the cap is always enforced. |

## Authentication

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `AUTH_EMAIL_FROM` | RFC5322 address | `Bivy <login@bivy.local>` | Magic-link sender |
| `GITHUB_OAUTH_CLIENT_ID` | string | unset | GitHub sign-in. If either half is missing, the GitHub auth endpoints return 501 |
| `GITHUB_OAUTH_CLIENT_SECRET` | string | unset | |
| `DISABLE_DEV_LOGIN` | `1` | **unset — dev login is enabled outside production** | Hard kill switch for `POST /auth/dev-login`, which mints a full account session for any email with no verification. **Set this to `1`** |
| `ALLOW_DEV_LOGIN` | `1` | unset | Re-enables dev login under `NODE_ENV=production`. Setting it in production makes the service exit 1 |

## Billing (hosted only)

Everything in this section exists to run Bivy as a paid hosted service. **If you
are self-hosting, skip it.** Leave these unset along with `ENFORCE_ENTITLEMENTS`
and every account on your stack gets every feature — there is no paywall to
unlock and nothing to configure. `deploy/.env.example` and `deploy/self-host.sh`
deliberately omit these variables for that reason.

The paid single-user plan has the internal id `pro` and is sold as "Pro". It was
`individual` before; the control plane migrates stored accounts on boot and still
accepts the old id from clients released before the rename.

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_…` | unset | With no Stripe client, billing endpoints return stub URLs **and the webhook applies plan changes without verifying a signature** |
| `STRIPE_PRICE_PRO` | `price_…` | unset | Checkout returns 500 without it |
| `STRIPE_PRICE_TEAM` | `price_…` | unset | Also gates whether the `team` plan is accepted at all |
| `BILLING_SUCCESS_URL` | URL | `<base>/?checkout=success` | |
| `BILLING_CANCEL_URL` | URL | `<base>/?checkout=cancel` | |
| `BILLING_PORTAL_RETURN_URL` | URL | `<base>/` | |

## Web Push

| Variable | Type | Default |
| --- | --- | --- |
| `WEB_PUSH_VAPID_PUBLIC_KEY` (legacy alias `VAPID_PUBLIC_KEY`) | VAPID key | `""` |
| `WEB_PUSH_VAPID_PRIVATE_KEY` (legacy alias `VAPID_PRIVATE_KEY`) | VAPID key | `""` |
| `WEB_PUSH_SUBJECT` | `mailto:` or https URL | `mailto:support@bivy.sh` |

## GitHub webhooks

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `BIVY_GITHUB_BOT_MENTION` | bare login | `bivy` | Fallback `@mention` handle for webhook triggers, when the per-account setting is unset |

Per-account GitHub and Slack webhook signing secrets live in the database, not
in the environment.

---

# Relay (self-host only)

Only relevant if you run your own relay (`services/relay`). The relay is a
dumb, end-to-end-encrypted pipe — it holds no database.

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | string | unset | Only enables the `RELAY_SECRET` fail-fast |
| `RELAY_SECRET` | opaque string | **`dev-relay-secret`** | Must match the control plane. Required in production, where a default value makes the relay exit 1 |
| `CONTROL_PLANE_URL` | URL | `http://localhost:4400` | Where the relay introspects tickets |
| `PORT` | integer | `4500` | |
| `RELAY_SHARD_ID` | string | unset | Observational label only, reported in `/healthz` and `/metrics`. No routing effect |
| `ENFORCE_ENTITLEMENTS` | `1` | **off** | When off, any valid ticket connects regardless of plan |
| `RELAY_MAX_FRAME_BYTES` | integer bytes | `262144` (256 KiB) | Larger inbound frames are rejected |
| `RELAY_MAX_CLIENT_MESSAGES_PER_MINUTE` | integer | `600` | Rate cap on phone/browser sockets |
| `RELAY_MAX_NODE_MESSAGES_PER_MINUTE` | integer | `6000` | Rate cap on node sockets |
| `RELAY_MAX_MESSAGES_PER_MINUTE` | integer | unset | **Deprecated.** Used only as a fallback for the client limit; explicitly ignored for node sockets, with a warning |
| `RELAY_MAX_CONNECTIONS_PER_IP` | integer | `50` | |
| `RELAY_IDLE_TIMEOUT_MS` | integer ms | `120000` | Heartbeat/idle timeout |
| `RELAY_MAX_BUFFERED_BYTES` | integer bytes | `16777216` (16 MiB) | Outbound backpressure high-water mark; a socket above it is evicted |

---

# Build and release

Maintainer tooling. You do not need any of these to run Bivy.

## `install.sh`

| Variable | Type | Default | Status |
| --- | --- | --- | --- |
| `BIVY_HOME` | path | `$HOME/.bivy/app` | Supported — install destination |
| `BIVY_VERSION` | npm version or dist-tag | `latest` | Supported — install a specific version, e.g. `0.1.0` |
| `BIVY_NPM_PREFIX` | path | npm's global prefix | Supported — install into a user-owned prefix instead of needing sudo |
| `BIVY_INSTALL_ALL_AGENTS` | `1` | unset | Supported — preinstall every bundled agent instead of just the one setup picks |

What `install.sh` does: installs prerequisites (including Node 22 via
NodeSource on apt systems), downloads the tarball and manifest, verifies the
SHA-256 against the manifest and the manifest's Ed25519 signature, extracts to a
staging dir, runs `npm ci --omit=dev`, carries the previous `.bivy` state
directory across, atomically swaps the install (restoring the backup on any
failure), symlinks `~/.local/bin/bivy`, and finally runs `bivy setup` (or
`bivy restart` if this was an update of a service install). It installs no
service unit itself — `bivy setup` does that.

Checksum verification is on and fail-closed. Signature verification is
fail-closed by policy, but only actually runs when a verification key is
available.

## `scripts/build-release.mjs`

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |

Publishing is driven by flags, not environment: `--publish`, `--dry-run`.

## Other

| Variable | Where | Default | Notes |
| --- | --- | --- | --- |
| `GH_ENV` | `scripts/sync-github-env.sh` | `staging` | Target GitHub environment |
| `BIVY_CODEX_E2E` | `test/codex-approvals-e2e.test.ts` | unset | `1` runs the Codex end-to-end test |
| `BIVY_TEST_SECRET` | `test/secrets.test.ts` | unset | Test fixture for `env://` resolution |

`scripts/secret-scan.mjs`, `scripts/check-licenses.mjs`,
`scripts/run-tests.mjs` and `scripts/disable-git-hooks.mjs` read no environment
variables.

## Server maintenance scripts (`deploy/`)

For operators running the self-hosted stack on a box.

| Variable | Script | Type | Default |
| --- | --- | --- | --- |
| `BIVY_PRUNE_DOCKER` | `prune.sh` | `0` disables | `1` |
| `BIVY_PRUNE_DOCKER_ALL` | `prune.sh` | `1` runs `docker system prune -af` | `0` |
| `BIVY_PRUNE` | `self-host.sh` | `0` \| `1` \| unset | unset = prune only when a stack already exists |
| `DATABASE_URL` | `self-host.sh` | postgres URL | unset = bundled Postgres container |
| `CP_DOMAIN`, `RELAY_DOMAIN` | `self-host.sh` | hostname | positional args (`<app-domain> <relay-domain>`) |
