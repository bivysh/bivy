# Aider

The popular git-native pair-programming CLI (`aider-chat`), run under Bivy as
one non-interactive turn per prompt (`aider --yes-always --message "<prompt>"`).

- **Runtime id:** `aider` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
python3 -m pip install --user aider-chat
```

## Authentication

**Auth owner: mixed.** Aider resolves its provider from whichever model alias
you pick, and Bivy's vault forwards the matching credential automatically —
so the exact login depends on the model:

| Model alias | Provider | Sign in with |
| --- | --- | --- |
| `sonnet`, `opus` | Anthropic | `bivy provider login anthropic` |
| `gpt-5`, `o3` | OpenAI | `bivy provider login openai` |
| `gemini` | Google | `bivy provider login google` |
| `deepseek` | DeepSeek | `bivy provider login deepseek` |

Bivy forwards the stored credential as that provider's standard key variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`).
Aider's own config (e.g. its own `.env`/`.aider.conf.yml`) also works if you'd
rather manage keys outside Bivy.

## Models

Wired to Aider's `--model` flag with a curated alias list (Aider resolves its
own short aliases to concrete provider models):

| id | name |
| --- | --- |
| `sonnet` | Claude Sonnet (alias) |
| `opus` | Claude Opus (alias) |
| `gpt-5` | GPT-5 |
| `o3` | OpenAI o3 |
| `gemini` | Gemini (alias) |
| `deepseek` | DeepSeek (alias) |

Override the list per node with `BIVY_AIDER_MODELS`.

## Resume

**No.** Stock `aider-chat` has no "continue session `<id>`" flag upstream —
its own continuity is `--restore-chat-history`, which reads
`.aider.chat.history.md` scoped to the working directory rather than to a
session id. Bolting that onto Bivy's generic resume primitive would be unsafe:
a second, unrelated session opened in the same workspace would inherit that
file's history. Every prompt runs as a fresh process.

## Known gaps

- No resume (above) — plan on single-turn-per-prompt continuity via the chat
  transcript only, not a re-attachable Aider session.
- Governance is effect-level (sandbox tier / FS-MCP-network channels), not
  per-tool approval cards.
- No package installs or session fork through this runtime.

## Run it

Pick Aider in the agent picker, or:

```bash
bivy run aider
```
