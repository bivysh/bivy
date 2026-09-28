# Agent instructions

Agent instructions are one Markdown document of your own preferences that every
agent session receives, on every machine on your account. They are added to
whatever the agent already loads from the workspace (`AGENTS.md`, `CLAUDE.md`,
…); they don't replace it. If the two conflict, the repository's instructions
win. Bivy says so to the agent in a short preamble above your text.

Edit them in **Settings → Agent instructions** in the web app or the iOS app.
Changes apply to sessions started after you save.

## How each agent receives them

| Agent | Channel |
| --- | --- |
| Claude Code | Appended to the system prompt, after Bivy's own note. |
| Codex | `developerInstructions` on `thread/start` / `thread/resume`. |
| Pi | Appended to the system prompt. |
| OpenCode | An `instructions` entry in `OPENCODE_CONFIG_CONTENT` (skipped if you already set that variable). |
| Other CLI and ACP agents | The `instructions` of Bivy's `bivy` MCP server, where Bivy injects that server. How much weight an agent gives MCP instructions is up to the agent. |

Adding a native channel for another CLI agent is a data change: set
`instructions: { env: { … } }` on its entry in `src/agents/profiles.ts`, where
`{file}` is the path to the composed instructions and `{fileJson}` is that path
escaped for a JSON string. Protocol shims (`bivy-agent-protocol`) receive the
text as `instructions` on `session.create` and `session.resume`.

## Storage and sync

- On each machine the document is `AGENTS.md` in the Bivy data directory
  (`BIVY_DATA_DIR`, default `<install>/.bivy`). You can edit it by hand.
- It syncs to the account's other machines inside the end-to-end encrypted
  model-auth vault envelope ([credential-sync.md](credential-sync.md)). The
  control plane only stores ciphertext.
- The most recent write wins. The file's modification time is the clock, and a
  synced copy keeps its writer's timestamp. To clear the instructions, save an
  empty document. If you delete the file, the synced copy comes back.
- Saving from the app is refused if the document changed on another device
  after you loaded it. The editor then lets you load that version or keep yours.
- The limit is 16 KB, because the text is sent on every turn of every session.
- Hosted runners, which only hold credentials you granted for unattended runs,
  don't receive the instructions.
