# Agent instructions

Agent instructions are one Markdown document of your own preferences that every
agent session receives, on every machine on your account. They are added to
whatever the agent already loads from the workspace (`AGENTS.md`, `CLAUDE.md`,
…); they don't replace it. If the two conflict, the repository's instructions
win. Bivy says so to the agent in a short preamble above your text.

Edit them in **Settings → Agent instructions** in the web app or the iOS app.
Changes apply to sessions started after you save.

## The Bivy note

By default every session gets a short note from Bivy first, even when you haven't written
any instructions. It tells the agent it runs inside Bivy, that you follow along in
a chat and can't see its terminal or files on disk, and which commands reach you:
`bivy attach` (or the `attach_to_chat` tool) to send a file or image,
`bivy app publish` / `run` / `shot` / `present` to preview, check and hand over
something with a UI ([apps.md](apps.md)), `bivy suggest` to propose a task
you can start in one tap, `bivy notify` and `bivy ask` to message you or wait
for your answer, and `bivy delegate` to hand a task to another agent or
machine when you ask for one ([agent-delegation.md](agent-delegation.md)). It
mentions Bivy automations for work that should run on its own later. It
ends by pointing at `bivy context` and `bivy help` for everything else. The
commands find the session through
`$BIVY_SESSION_ID`, so any agent with a shell can use them. The note is
`BIVY_AGENT_NOTE` in `src/agent-instructions.ts` and uses the channels below.

To turn the note off, switch off **Send Bivy's system instructions** in
**Settings → Agent instructions**. **View system instructions** there shows the
exact text. The switch syncs to your other machines along with your
instructions. With the note off and no instructions of your own, sessions get
nothing extra.

## How each agent receives them

| Agent | Channel |
| --- | --- |
| Claude Code | Appended to the system prompt. |
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
  get the Bivy note but not your instructions.
