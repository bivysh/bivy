# Qwen Code

Alibaba's Qwen Code CLI (`@qwen-code/qwen-code`) — a Gemini-CLI fork tuned for
Qwen-Coder models. Bivy reuses Gemini's JSON parser, approval-mode
containment, and resume form, since Qwen Code shares that CLI shape.

- **Runtime id:** `qwen` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @qwen-code/qwen-code
```

## Authentication

**Auth owner: agent.** Qwen Code owns its own sign-in — run it once and
complete its login:

```bash
qwen
```

Separately, and automatically: a Bivy-vault credential stored under the
`qwen` provider is forwarded to the process every turn as `QWEN_API_KEY`
(Bivy's generic per-provider convention). The native login above is the reliable
path; this hand-off only helps if your Qwen Code version reads `QWEN_API_KEY`
from the environment:

```bash
bivy login   # pick the Qwen entry from the menu, if present
```

## Models

Wired to Qwen Code's `-m` flag (same shape as Gemini's):

| id | name |
| --- | --- |
| `qwen3-coder-plus` | Qwen3 Coder Plus |
| `qwen3-coder-flash` | Qwen3 Coder Flash |

Override the list per node with `BIVY_QWEN_MODELS`.

## Resume

Yes — `--resume <id>` continues a previous session, the same headless resume
form Gemini CLI uses. A resumed turn re-derives `--approval-mode` from the
current sandbox tier.

## Known gaps

- Containment is `--approval-mode`, not per-tool Approve/Deny cards —
  `toolInterception` is off for this runtime.
- No package installs or session fork through this runtime.

## Run it

Pick Qwen Code in the agent picker, or:

```bash
bivy run qwen
```
