# Agent-native Bivy

**Goal:** an agent dropped into any Bivy session, with no prior knowledge, can
discover every Bivy capability (chat, attachments, previews, runs, automations,
terminals, delegation, notifications, questions, forks) and use it correctly the
first time. The user interface and the agent interface should be equal: if a
person can do something in the app, an agent can do it with a named, documented
verb.

The model is a well-built Unix system. Every capability is a command. Names are
predictable, so the tool can be found by its prefix. `--help` is always correct,
config is text, and output parses. Agents are already good at shells, so Bivy
should be a very good shell tool, not a new protocol they have to learn.

## Where we are (2026-09-30)

What works:

- `BIVY_AGENT_NOTE` (`src/agent-instructions.ts`) is short and rides on every
  turn. It is delivered natively per agent: `systemPrompt.append`,
  `developerInstructions`, `OPENCODE_CONFIG_CONTENT`, and MCP `instructions`.
- The `bivy` CLI reaches most things. `$BIVY_SESSION_ID` gives session-scoped
  commands (`attach`, `suggest`, `app`, `delegate`) the right default target.
- The client-command boundary already has declarative TypeBox schemas
  (`src/protocol/client-command-schemas.ts`).
- `bivy capabilities --json` and `bivy agents --json` provide machine
  introspection.

What breaks discovery:

| Problem | Evidence |
|---|---|
| No single command list | `printHelp` leaves out `attach`, `suggest`, `delegate`, `promote`, `audit`, `diagnostics`, `credentials`, `mcp-*`. Completions leave out `auth`, `creds`, `completions`, `mcp-*`. `docs/cli-reference.md` leaves out `app`, `delegate`, `capabilities`, `audit`, `diagnostics`, `mcp-serve`. Nothing checks any of these. |
| Inconsistent output contract | `--json` is missing on `attach`, `suggest`, `send`, `kill`, `doctor`, `logs`, `secrets`, `credentials`. `app` always prints JSON and ignores `--json`. Exit codes differ per command. |
| MCP is almost empty | `bivy mcp-serve` exposes only `attach_to_chat`. An agent without a shell tool can't suggest, preview, delegate or notify. Integration tools reach only Claude and Pi. |
| Capabilities that only the UI can use | Forks and session moves, push notifications, approvals, GitHub and Linear pickup, editing agent instructions, and enabling or disabling automations. |
| No asking the user across agents | Questions work only where we intercept the native AskUserQuestion (Claude, Pi). |
| Auth is all-or-nothing | An agent can mint a full device token from `bootstrap.json`. There is no session-scoped credential, and `BIVY_MCP_TOKEN` is read but never set. |
| No task-level guidance | The note lists four commands. Beyond that there's no "how do I do X in Bivy" layer between the note and a 1000-line reference. |

## Principles

1. **One registry, many projections.** Each capability is described once, as
   data. Help, completions, the reference doc, MCP tools, `bivy schema`,
   `llms.txt` and skills are all generated from that description, so drift can't
   happen. (This follows the "data over code" rule: adding a command means
   adding a row.)
2. **Progressive disclosure.** The always-on note stays tiny. Everything else
   can be fetched on demand, and each layer names the next one.
3. **One contract for every command.** The same flags, output shapes, exit codes
   and error shape everywhere, so an agent that has learned one command has
   learned them all.
4. **Context is implicit and inspectable.** Commands default to "this session,
   this workspace, this machine", and one command shows the agent what that
   context is and what it's allowed to do.
5. **Parity between the UI and the agent.** Every UI action has a verb. A new
   feature isn't done until its verb exists.
6. **Agent-agnostic.** Shell first because every agent has one, and MCP
   generated from the same rows for agents that prefer tools. No per-agent
   adapters.
7. **Measured.** Real agents run real tasks with only the note, and we track
   whether they succeed.

## Design

### 1. The command registry

Build one table (for example `src/cli/registry.ts`), with one row per verb:

```ts
{
  name: "app present",
  summary: "Tell the user a visible change is ready to look at",
  scope: "session",          // session | node | account
  effect: "notify",          // read | write | notify | destructive
  args: Type.Object({ target: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }),
  output: Type.Object({ ok: Type.Boolean(), cardId: Type.String() }),
  route: { ws: "apps.present" },        // or http / control-plane
  examples: ['bivy app present --note "Header now wraps on mobile"'],
  guides: ["show-the-user"],
}
```

- `args` and `output` reuse the existing TypeBox rows in
  `client-command-schemas.ts`, so they aren't restated.
- `bin/bivy.mjs` dispatch moves command by command onto the registry. Commands
  that haven't moved yet are still listed in the registry with `route: legacy`,
  so discovery is complete from day one.
- The following are generated from the registry:
  - `bivy help`
  - `bivy <cmd> --help`
  - shell completions
  - `docs/cli-reference.md`
  - MCP tool list
  - `bivy schema`
  - `llms.txt`
  - skills
- `pnpm run check:cli` fails CI when a dispatched command has no row, or when
  generated files are stale.

### 2. Layers of discovery

| Layer | Size | Delivered | Contents |
|---|---|---|---|
| Note | ~12 lines | every turn | What Bivy is, the four core moves (show, preview, suggest, notify or ask), and "run `bivy guide` for more" |
| `bivy guide [topic]` | 1 screen per topic | on demand | Playbooks organized by intent (below) |
| `bivy help` / `<cmd> --help` | per command | on demand | Generated usage, flags, examples, exit codes |
| `bivy schema [cmd] --json` | JSON | on demand | Arguments and output schema for every command |
| `bivy context --json` | JSON | on demand | Where the agent is and what it may do |
| MCP resources | same content | MCP clients | `bivy://guide/*`, `bivy://context` |
| Skills | generated `SKILL.md` | written into agents that support skills | One skill per guide, with trigger descriptions |

Guides are organized around what the agent is trying to do, not around command
names, because agents look things up by intent:

- `show-the-user`: `attach`, `app publish`, `app shot`, `app present`, and when
  to use each
- `talk-to-the-user`: `notify` versus `ask` versus plain chat, urgency, and not
  spamming
- `long-work`: `runs start` / `wait`, receipts and checks, `exec` for a one-shot
  answer
- `automate`: `automation init` / `validate` / `plan` / `apply`, triggers, and
  testing filters
- `more-hands`: `delegate`, forks, and sibling sessions
- `terminals`: running something the user can watch or take over
- `configure`: config, secrets, credentials, and plugins
- `work-queues`: picking up GitHub or Linear items

`bivy guide` with no topic prints the list with a one-line summary each. Guides
are markdown under `docs/guides/`, published on the website, and the same files
ship inside the CLI.

### 3. One contract for every command

- **Output.** `--json` on every command prints one JSON object. Streaming
  commands (`send`, `runs wait --follow`, `logs`) print NDJSON. Human text is
  the default. `BIVY_OUTPUT=json` sets JSON for a whole session, and agents get
  it set by default.
- **Errors.** Errors go to stderr as
  `{ "error": { "code": "session_not_found", "message": "...", "hint": "...", "next": "bivy sessions --json" } }`.
  Every error should name the command that gets the agent unstuck.
- **Exit codes** (one table, documented):

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | failed |
  | 2 | usage |
  | 3 | not found |
  | 4 | denied or unauthenticated |
  | 5 | timeout |
  | 6 | conflict |
  | 75 | temporary, try again |

  `runs wait` already fits except for the timeout code.
- **Mutations.** Every mutation accepts `--dry-run`, which prints the plan.
  Destructive mutations also take `--yes`, and `effect: destructive` in the
  registry makes that required. Commands that create something accept
  `--idempotency-key`, so a retrying agent doesn't create two runs.
- **Waiting.** `--wait` blocks until the result is ready, `--follow` streams
  progress, and `--timeout <dur>` bounds both. The same three flags work
  everywhere.
- **Mistakes.** An unknown command or flag prints a "did you mean" suggestion
  and points to `bivy help`, instead of a bare usage line.

### 4. `bivy context`

This is the first thing a capable agent should run:

```jsonc
{
  "session": { "id": "…", "name": "…", "agent": "claude", "forkedFrom": null },
  "workspace": { "path": "…", "repo": "bivysh/bivy", "branch": "…", "worktree": true },
  "machine": { "name": "staging", "os": "linux", "gpu": false },
  "user": { "watching": true, "devices": ["phone"], "lastSeen": "…" },
  "apps": [{ "id": "web", "url": "…" }],
  "allowed": { "notify": true, "delegate": true, "runs": true, "automation.apply": false },
  "guides": ["show-the-user", "talk-to-the-user", "…"]
}
```

- `user.watching` comes from presence. It is what lets an agent choose between
  answering in chat and sending a push notification.
- `allowed` comes from the scoped session token (section 7), so the agent knows
  in advance what it may do instead of learning through a denial.

### 5. Verbs that fill the gaps

Every capability that is currently UI-only gets a verb. Each is one registry
row, backed by an existing controller.

| Verb | Purpose | Backed by |
|---|---|---|
| `bivy notify "<text>" [--urgent] [--link app\|run\|file]` | Reach the user when they're away: finished, blocked, needs a look | Push pipeline plus a chat card. Rate-limited per session. |
| `bivy ask "<q>" [--option a --option b] [--wait\|--async]` | Ask the user a structured question from any agent | `src/question.ts` generalized beyond AskUserQuestion interception. `--async` returns an id, and `bivy ask status <id>` reads the answer. |
| `bivy fork [--agent x] ["<first prompt>"]`, `bivy session move --machine m` | Branch the work, or move it | `fork-commands.ts` |
| `bivy terminal open\|list\|send\|read\|close` | A terminal the user can see and take over | `/api/terminals`, `/api/commands` |
| `bivy approvals list\|approve\|reject` | For supervisor agents and automations | `/api/approvals` |
| `bivy work list\|pickup` (github, linear) | Pull from work queues | `/api/github/issues/*`, Linear tasks |
| `bivy automation enable\|disable\|runs <id>` | Complete the automation lifecycle | control plane |
| `bivy instructions show\|edit` | Read or change account-wide agent instructions | `agent-instructions.ts` |
| `bivy status --session` | Report "working on X, 3/5 done" to the session header | presence and status line |

The new "four core moves" in the note become: **show** (`attach` / `app`),
**suggest**, **notify**, and **ask**. Everything else is found through
`bivy guide`.

### 6. MCP generated from the registry

- `bivy mcp-serve` exposes every row with `scope: session` and an `effect`
  other than `destructive` as a tool. Tool names use underscores
  (`app_present`, `notify`, `ask`, `suggest`, `delegate`, `runs_start`). Input
  schemas come straight from `args`.
- It also exposes resources (`bivy://context`, `bivy://guide/{topic}`) and puts
  the note in `instructions`.
- The integration tools (Notion, Gmail, …) move behind the same server, so every
  agent gets them, not only the SDK agents.
- The node sets `BIVY_MCP_TOKEN` to the scoped session token, which fixes
  multi-user hosts.
- Governed Runs stay deliberately out of MCP until policy says otherwise. That
  rule becomes a registry flag (`mcp: false`) instead of a code comment.

### 7. A scoped session token (safety that makes autonomy possible)

- At session start, the node mints `BIVY_SESSION_TOKEN` for that session. Its
  scopes come from project policy: session verbs by default, plus opt-ins such
  as `automation.apply` and `delegate`.
- The CLI and MCP use this token, not the bootstrap secret. Reading
  `bootstrap.json` from a session is refused on multi-user hosts, and the
  single-user loopback bypass is documented as a trust boundary.
- Every agent-initiated action is audited with its session id. `bivy audit
  --session` shows the user what the agent did through Bivy.
- A denial returns exit code 4 with the missing scope, and says how the user
  can grant it.

Without this, broad discovery is a liability. With it, we can safely advertise
everything.

### 8. Measuring it: agent usability certification

`certification/` already checks agents against Bivy. Add an **agent-ux suite**:
scripted tasks that each supported agent runs with only the default note, in a
fresh session.

- "Take a screenshot of the running app at mobile width and show it to me."
- "When the test suite finishes, notify me with the result."
- "Ask me which of these two designs I prefer before continuing."
- "Set up a nightly automation that runs lint and opens an issue on failure
  (dry run)."
- "Get a second opinion from Codex on this diff."

For each agent and task, score success, turns used, wrong commands tried, and
whether it read a guide. Commands that agents tried but that don't exist are the
most useful signal: they show which name agents expected. Keep a local counter
of those misses (unknown commands and flags, by name, with no content) that
feeds `bivy doctor --agents` and the next rename or alias.

## Sequencing

| Phase | Scope | Size |
|---|---|---|
| 0: Quick wins | Fix help, completions and reference drift by hand. Add `delegate` to `docs/agent-instructions.md`. Add `--json` to `attach`, `suggest` and `send`. Make `app` respect `--json`. Add "did you mean". Set `BIVY_MCP_TOKEN`. | small |
| 1: Registry | Registry table. Generate help, completions and reference. Add the `check:cli` guard. Add `bivy schema` and `bivy context`. Adopt the shared exit-code and error contract. | medium |
| 2: Discovery | `bivy guide` plus the eight guides. Generated skills and `llms.txt`. MCP generated from the registry, with resources. Tighten the note to point at `guide`. | medium |
| 3: Gap verbs | `notify` and `ask` first (the biggest change in how an agent feels to work with), then `terminal`, `fork`, `work`, `approvals`, and the automation lifecycle. | medium to large |
| 4: Scoped tokens | Session token, scopes from policy, audit by session. | medium |
| 5: Measurement | Agent-ux certification suite, the miss counter, and a scorecard per agent in CI or on release. | medium |

Phases 0 and 1 unblock everything else. Phase 3's `notify` and `ask` can run in
parallel with phase 2, because they need only a registry row.

## Open questions

- **Should `BIVY_OUTPUT=json` default on for agent sessions?** It makes parsing
  reliable, but tool output in the chat becomes harder for the user to read.
  Recommendation: yes, and render JSON tool output as cards in the UI.
- **Should `ask --wait` block the agent's turn, or end the turn and resume on
  the answer?** Blocking is simpler for agents. Resuming frees the machine.
  Recommendation: block, with a timeout, and fall back to `--async`.
- **Should skills be written into the repo or the user's home directory?**
  Neither. Write them into the session's agent config, the same way
  `mcp-inject.ts` does, so repositories stay clean.
