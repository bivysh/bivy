# Gemini CLI

Google's terminal coding agent (`@google/gemini-cli`), run headlessly under
Bivy with structured JSON output.

- **Runtime id:** `gemini` · **Tier:** Beta · **In picker:** Yes

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
bivy login   # pick the Google/Gemini entry from the menu
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

## Run it

Pick Gemini CLI in the agent picker, or:

```bash
bivy run gemini
```
