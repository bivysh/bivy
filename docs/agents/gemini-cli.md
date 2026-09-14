# Gemini CLI

Google's terminal coding agent (`@google/gemini-cli`), run headlessly under
Bivy with structured JSON output.

- **Runtime id:** `gemini` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @google/gemini-cli
```

## Authentication

**Auth owner: agent.** Gemini CLI owns its own sign-in — run it once and
complete its login:

```bash
gemini
```

Separately, and automatically: if you've signed in to the matching provider
through Bivy's own vault, that credential is forwarded to the `gemini` process
every turn as `GEMINI_API_KEY`:

```bash
bivy provider login   # pick the Google/Gemini entry from the menu
```

## Models

Wired to Gemini CLI's `-m` flag:

| id | name |
| --- | --- |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash |

Override the list per node with `BIVY_GEMINI_MODELS`.

## Resume

Yes — `-r <id>` continues a previous session (`"latest"` or an index also
work upstream, but Bivy always passes the session's own id). A resumed turn
re-derives `--approval-mode` from the current sandbox tier, so it stays as
contained as a fresh launch.

## Known gaps

- Containment is Gemini's own `--approval-mode`, not per-tool Approve/Deny
  cards — `toolInterception` is off for this runtime.
- No package installs or session fork through this runtime.

## ACP promotion (per-tool approvals)

Gemini CLI speaks the [Agent Client Protocol](https://agentclientprotocol.com),
so it can be driven through Bivy's governed `ProtocolRuntime` instead of the
one-shot pipe — earning **per-tool Approve/Deny** and `session/load` resume:

```bash
BIVY_GEMINI_ACP=1 bivy run gemini     # this agent, via ACP
BIVY_PREFER_ACP=1 …                    # every ACP-capable agent, via ACP
```

Declared as data (`acp: { args: ["--experimental-acp"] }`); off by default until
validated for your version. See [acp.md](acp.md).

## Run it

Pick Gemini CLI in the agent picker, or:

```bash
bivy run gemini
```
