# Agent setup pages

One short page per agent in the picker: the install command, how
authentication works (Bivy's shared credential vault vs. the agent's own
login), the exact login step, model selection, resume support, and known
gaps. For the bigger picture — tiers, capabilities across all runtimes, and
what's hidden from the picker — see
[runtime-support-matrix.md](../runtime-support-matrix.md).

| Agent | Auth owner | Resume |
| --- | --- | --- |
| [Pi](pi.md) | Bivy | Yes |
| [Claude Code](claude-code.md) | Mixed | Yes |
| [Codex](codex.md) | Agent (Bivy bridges ChatGPT/API-key logins) | Yes |
| [OpenCode](opencode.md) | Agent | Yes |
| [Gemini CLI](gemini-cli.md) | Agent | Yes |
| [Qwen Code](qwen-code.md) | Agent | Yes |
| [Goose](goose.md) | Agent | Yes |
| [Aider](aider.md) | Mixed | **No** |
| [Cline](cline.md) | Agent | Yes (best-effort flags) |
| [Crush](crush.md) | Agent | **No** |
| [Cursor](cursor.md) | Agent | Yes |
| [GitHub Copilot](copilot.md) | Agent | **No** |
| [Grok](grok.md) | Agent | **No** |
| [Amp](amp.md) | Agent | Yes (threads) |
| [Auggie](auggie.md) | Agent | **No** |
| [Droid](droid.md) | Agent | **No** |
| [Continue](continue.md) | Agent | **No** |
| [Kilo Code](kilocode.md) | Agent | Yes |
| [Rovo Dev](rovodev.md) | Agent | Yes |

One more, [Codebuff](codebuff.md), is supported as a runtime (`BIVY_RUNTIME=codebuff`)
but is **hidden from the picker**: its `codebuff` binary has no verified non-TTY
headless mode yet (automation is via `@codebuff/sdk`), so a picker entry would
hang on a pipe. It flips into the picker as a data-only change the moment a
headless flag ships upstream.

They all share one mechanism worth knowing up front: whenever you sign in to a
model provider with `bivy login`, Bivy's vault forwards that credential to
*every* agent process as the provider's conventional environment variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) each turn — not
just to Pi. That's on top of, not instead of, whatever native login an agent
owns itself; only Anthropic's Claude Pro/Max subscription and a connected
ChatGPT/Codex subscription are bridged as OAuth, everything else that's a
subscription (not an API key) stays agent-native. See
[key-management.md](../key-management.md) and
[credential-sync.md](../credential-sync.md) for the vault itself.
