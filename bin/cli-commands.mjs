// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The `bivy` command table: one row per top-level command. bin/bivy.mjs
// dispatches only commands found here, and `bivy help`, `bivy help --json`,
// shell completions, "did you mean" and `pnpm run check:cli` (which keeps
// docs/cli-reference.md in step) all read these rows. Adding a command means
// adding a row; a command without one cannot be dispatched.
//
// Fields:
//   name        canonical name (what the dispatcher switches on)
//   aliases     other spellings that dispatch to it
//   group       help section (GROUPS below, in display order)
//   usage       one-line synopsis after `bivy`
//   summary     what it does, one line
//   scope       "session" (acts on $BIVY_SESSION_ID), "node" (this machine) or "account"
//   json        true when it accepts --json (or honors BIVY_OUTPUT=json)
//   subcommands first-argument verbs, for completion and discovery
//   hidden      plumbing launched by Bivy itself; left out of help and completions

/** Exit codes shared by the commands agents call. 0 and 1 hold everywhere. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, notFound: 3, denied: 4, timeout: 5, conflict: 6, unavailable: 75 });

export const GROUPS = [
  ["session", "Inside an agent session (defaults to $BIVY_SESSION_ID)"],
  ["sessions", "Agents and sessions"],
  ["runs", "Runs and automations"],
  ["node", "This node"],
  ["accounts", "Accounts, providers and credentials"],
  ["config", "Configuration and extensions"],
  ["help", "Help and discovery"],
];

export const COMMANDS = [
  // Inside an agent session
  { name: "context", group: "session", scope: "session", json: true, usage: "context [--json]", summary: "Where this agent is running: session, workspace, machine, apps, and what to run next" },
  { name: "attach", group: "session", scope: "session", json: true, usage: 'attach <file> [--caption "…"] [--artifact]', summary: "Show a local file or image to the user in the chat" },
  { name: "suggest", group: "session", scope: "session", json: true, usage: 'suggest "<task>" [--title "label"]', summary: "Propose a task the user can start in one tap" },
  { name: "app", group: "session", scope: "session", json: true, usage: "app <publish|shot|present|share|run|…>", summary: "Live previews: publish a web/terminal/desktop app, screenshot it, present it", subcommands: ["publish", "list", "remove", "shot", "present", "share", "notes", "run", "click", "type", "key", "scroll", "drag", "move", "menu"] },
  { name: "delegate", group: "session", scope: "session", json: true, usage: 'delegate "<task>" [--agent <id>] [--machine <name>] [--wait]', summary: "Hand a task to another agent or machine and get its answer back", subcommands: ["machines", "status", "wait"] },

  // Agents and sessions
  { name: "run", group: "sessions", scope: "node", usage: "run <agent> [--chat] [--name …] [--model …] [--node …] [--workspace …]", summary: "Run an agent (native CLI/TUI) as a session the app can see" },
  { name: "exec", group: "sessions", scope: "node", json: true, usage: 'exec "<prompt>" [--agent …] [--session …]', summary: "One-shot headless session: prints the answer to stdout" },
  { name: "send", group: "sessions", scope: "node", json: true, usage: 'send <id> "<message>"', summary: "Send a prompt to an existing session and stream the reply" },
  { name: "sessions", aliases: ["ls"], group: "sessions", scope: "node", json: true, usage: "sessions [--json]", summary: "List recent sessions (live and saved) and resume one" },
  { name: "resume", group: "sessions", scope: "node", usage: "resume [n|id]", summary: "Resume a session directly (default: most recent)" },
  { name: "kill", group: "sessions", scope: "node", usage: "kill <id> [--delete]", summary: "Stop a session or terminal" },
  { name: "takeover", group: "sessions", scope: "node", usage: "takeover <id>", summary: "Stop a run-terminal's native TUI and continue it as a governed chat" },
  { name: "promote", group: "sessions", scope: "node", usage: "promote <session-id>", summary: "Continue a warm-replicated session on this node" },
  { name: "prune", aliases: ["clean"], group: "sessions", scope: "node", json: true, usage: "prune [--keep N] [--older-than 7d] [--dry-run]", summary: "Delete old sessions, workspaces and worktrees" },
  { name: "agents", group: "sessions", scope: "node", json: true, usage: "agents [--json]", summary: "List supported agents and which are installed" },
  { name: "agent", group: "sessions", scope: "node", json: true, usage: "agent <add|list|remove>", summary: "Connect, list or remove a user-owned agent", subcommands: ["add", "list", "remove"] },
  { name: "agents:install", aliases: ["runtimes:install"], group: "sessions", scope: "node", usage: "agents:install [--bridges]", summary: "Install known upstream agents" },
  { name: "shim", aliases: ["listen"], group: "sessions", scope: "node", usage: "shim [install|uninstall|status] <agent>", summary: "Make typing '<agent>' open its TUI in a session the app can see", subcommands: ["install", "uninstall", "status"] },

  // Runs and automations
  { name: "runs", group: "runs", scope: "account", json: true, usage: 'runs <start|list|status|wait>', summary: "Unattended Runs with checks, evidence and a Receipt", subcommands: ["start", "list", "status", "wait"] },
  { name: "automation", aliases: ["automations"], group: "runs", scope: "account", json: true, usage: "automation <list|trigger|init|validate|plan|test|apply>", summary: "Automations as code: validate, plan, apply, trigger", subcommands: ["list", "trigger", "init", "validate", "plan", "test", "test-filter", "apply"] },

  // This node
  { name: "setup", aliases: ["init"], group: "node", scope: "node", usage: "setup", summary: "First-run wizard: agent, model login, remote sign-in, background service" },
  { name: "start", aliases: ["dev"], group: "node", scope: "node", usage: "start", summary: "Run the daemon in the foreground" },
  { name: "stop", group: "node", scope: "node", usage: "stop", summary: "Stop the background service" },
  { name: "restart", group: "node", scope: "node", usage: "restart [--force]", summary: "Restart the background service after active turns finish" },
  { name: "status", group: "node", scope: "node", json: true, usage: "status [--json]", summary: "Show config and whether the node is reachable" },
  { name: "doctor", group: "node", scope: "node", usage: "doctor", summary: "Health check: deps, node, model, remote, agents" },
  { name: "diagnostics", group: "node", scope: "node", usage: "diagnostics [--out <file>]", summary: "Print a redacted, shareable diagnostics bundle" },
  { name: "capabilities", group: "node", scope: "node", json: true, usage: "capabilities [--json]", summary: "What this machine unlocks: OS, agents, providers, Docker/GPU, plugins" },
  { name: "logs", group: "node", scope: "node", usage: "logs [-f]", summary: "Tail the node logs" },
  { name: "audit", group: "node", scope: "node", json: true, usage: "audit [--session <id>] [--verify] [--json]", summary: "Show and verify the node's governance audit trail" },
  { name: "update", group: "node", scope: "node", usage: "update [--force]", summary: "Update Bivy, install deps and restart the service" },
  { name: "update:log", group: "node", scope: "node", usage: "update:log", summary: "Show output of the last (or in-progress) update" },
  { name: "service", group: "node", scope: "node", usage: "service <install|uninstall|status>", summary: "Manage the background service", subcommands: ["install", "uninstall", "status"] },
  { name: "rename", aliases: ["node:rename"], group: "node", scope: "node", usage: "rename <name>", summary: "Rename this node (no restart)" },
  { name: "nodes", group: "node", scope: "node", usage: "nodes [list|add|remove]", summary: "List, add or remove other nodes", subcommands: ["list", "add", "remove"] },
  { name: "token", group: "node", scope: "node", usage: "token", summary: "Print a device token for this node" },
  { name: "open", group: "node", scope: "node", usage: "open", summary: "Open the remote web app" },
  { name: "link", group: "node", scope: "node", usage: "link", summary: "Show a web app link as a QR code in the terminal" },
  { name: "relay:setup", group: "node", scope: "node", usage: "relay:setup", summary: "Enable secure remote web app access" },
  { name: "uninstall", group: "node", scope: "node", usage: "uninstall [--keep-sessions] [--dry-run]", summary: "Remove Bivy and all its data" },

  // Accounts, providers and credentials
  { name: "login", group: "accounts", scope: "account", usage: "login", summary: "Sign this machine into a Bivy account" },
  { name: "logout", aliases: ["signout"], group: "accounts", scope: "account", usage: "logout", summary: "Sign this machine out" },
  { name: "provider", aliases: ["model"], group: "accounts", scope: "node", usage: "provider login [provider]", summary: "Sign into a model provider", subcommands: ["login"] },
  { name: "auth", aliases: ["credentials", "creds"], group: "accounts", scope: "node", usage: "auth <list|add|remove|import|sync|…>", summary: "Model credentials: import local logins, add, sync", subcommands: ["list", "add", "remove", "sync", "preset", "ingest", "config", "import"] },
  { name: "secrets", aliases: ["secret"], group: "accounts", scope: "node", usage: "secrets <list|set|ref|delete|doctor|resolve>", summary: "Store tokens in the node vault", subcommands: ["list", "set", "ref", "delete", "doctor", "resolve"] },
  { name: "github:connect", aliases: ["connect-repo"], group: "accounts", scope: "node", usage: "github:connect [owner/repo]", summary: "Connect GitHub" },
  { name: "github:app-create", group: "accounts", scope: "node", usage: "github:app-create [--org <org>]", summary: "One-click: create and connect a GitHub App" },
  { name: "github:app-connect", group: "accounts", scope: "node", usage: "github:app-connect --app-id <id> --key <path.pem>", summary: "Connect an existing GitHub App" },
  { name: "github:app-sync", group: "accounts", scope: "account", usage: "github:app-sync [on|off]", summary: "Sync GitHub App keys to this account's other nodes" },

  // Configuration and extensions
  { name: "config", group: "config", scope: "node", json: true, usage: "config <show|get|set|unset|explain|validate|init|path>", summary: "Typed node configuration", subcommands: ["init", "validate", "show", "get", "set", "unset", "explain", "path"] },
  { name: "plugin", aliases: ["plugins"], group: "config", scope: "node", json: true, usage: "plugin <init|validate|doctor|test|install|list|remove>", summary: "Build and install plugins", subcommands: ["init", "validate", "doctor", "test", "install", "list", "remove"] },
  { name: "voice", aliases: ["stt"], group: "config", scope: "node", usage: "voice <provider|key|remove|status>", summary: "Configure speech-to-text", subcommands: ["provider", "key", "remove", "status"] },
  { name: "completions", aliases: ["completion"], group: "config", scope: "node", usage: "completions <bash|zsh|fish>", summary: "Print a shell completion script", subcommands: ["bash", "zsh", "fish"] },

  // Help and discovery
  { name: "help", aliases: ["-h", "--help"], group: "help", scope: "node", json: true, usage: "help [command] [--json]", summary: "Show this help, one command's row, or every command as JSON" },
  { name: "version", aliases: ["--version", "-v"], group: "help", scope: "node", usage: "version", summary: "Print the installed Bivy version" },

  // Plumbing
  { name: "mcp-serve", group: "help", scope: "session", hidden: true, usage: "mcp-serve", summary: "Bivy's MCP server for agents (stdio; injected into agent MCP config)" },
  { name: "mcp-proxy", group: "help", scope: "session", hidden: true, usage: "mcp-proxy -- <server command>", summary: "MCP proxy in front of an agent's own MCP servers (stdio)" },
];

const byWord = new Map();
for (const command of COMMANDS) for (const word of [command.name, ...(command.aliases ?? [])]) byWord.set(word, command);

/** The row for a typed command word (name or alias), or undefined. */
export function resolveCommand(word) {
  return typeof word === "string" ? byWord.get(word) : undefined;
}

// Edit distance where swapping two neighbors counts once ("hepl" → "help").
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Closest visible command names to a mistyped word, best first (at most 3). */
export function suggestCommands(word) {
  const typed = String(word ?? "").toLowerCase();
  if (!typed) return [];
  const scored = [];
  for (const command of COMMANDS) {
    if (command.hidden) continue;
    const words = [command.name, ...(command.aliases ?? [])].filter((w) => !w.startsWith("-"));
    const best = Math.min(...words.map((w) => (w.startsWith(typed) || typed.startsWith(w) ? 0 : distance(typed, w))));
    if (best <= Math.max(1, Math.floor(typed.length / 3))) scored.push([best, command.name]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, 3).map(([, name]) => name);
}

/** The words shells should complete after `bivy`. */
export function completionWords() {
  return COMMANDS.filter((command) => !command.hidden).flatMap((command) => [command.name, ...(command.aliases ?? []).filter((a) => !a.startsWith("-"))]);
}

/** Commands with first-argument verbs, for completing `bivy <cmd> <verb>`. */
export function subcommandTable() {
  return COMMANDS.filter((command) => !command.hidden && command.subcommands?.length).map((command) => ({
    words: [command.name, ...(command.aliases ?? [])],
    subcommands: command.subcommands,
  }));
}

/** One command as plain data: what `bivy help --json` and `bivy help <cmd> --json` print. */
export function describeCommand(command) {
  const { name, aliases = [], group, usage, summary, scope, json = false, subcommands = [] } = command;
  return { name, aliases, group, usage: `bivy ${usage}`, summary, scope, json, subcommands, help: `bivy ${name} --help` };
}

export function describeCli() {
  return {
    exitCodes: EXIT,
    output: "Commands marked json accept --json; BIVY_OUTPUT=json turns it on for every such command.",
    errors: "With --json, failures print {\"error\":{\"code\",\"message\",\"hint\"?,\"next\"?}} to stderr.",
    commands: COMMANDS.filter((command) => !command.hidden).map(describeCommand),
  };
}

/** `bivy help` text. `paint` colors a command synopsis (the CLI passes its cyan);
 *  `details` adds a line under a command, for lists only known at runtime. */
export function renderHelp({ paint = (s) => s, bold = (s) => s, details = {} } = {}) {
  const visible = COMMANDS.filter((command) => !command.hidden);
  const width = Math.min(44, Math.max(...visible.map((command) => command.usage.length)) + 5);
  const lines = [`${bold("bivy")} — Bivy node CLI`, ""];
  for (const [group, title] of GROUPS) {
    const rows = visible.filter((command) => command.group === group);
    if (!rows.length) continue;
    lines.push(bold(title));
    for (const command of rows) {
      const synopsis = `bivy ${command.usage}`;
      const pad = synopsis.length < width ? " ".repeat(width - synopsis.length) : "\n" + " ".repeat(width + 2);
      lines.push(`  ${paint(synopsis)}${pad}${command.summary}`);
      if (details[command.name]) lines.push(`${" ".repeat(width + 2)}${details[command.name]}`);
    }
    lines.push("");
  }
  lines.push("Every command takes --help. 'bivy help --json' lists all commands, flags that take --json, and exit codes.");
  lines.push("Agents: start with 'bivy context'.");
  return lines.join("\n");
}

/** `--json` was passed, or BIVY_OUTPUT=json asks for JSON everywhere. */
export function wantsJson(args = [], env = process.env) {
  return args.includes("--json") || String(env?.BIVY_OUTPUT ?? "").toLowerCase() === "json";
}

/**
 * The one error shape for commands agents call: JSON on stderr under --json, a
 * readable line otherwise, then exit with a code from EXIT. `next` names the
 * command that gets the caller unstuck.
 */
export function cliError({ code, message, hint, next, exit = EXIT.failed }, { json = false, paint = (s) => s } = {}) {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}), ...(next ? { next } : {}) } })}\n`);
  } else {
    process.stderr.write(`${paint(message)}\n`);
    if (hint) process.stderr.write(`${hint}\n`);
    if (next) process.stderr.write(`Try: ${next}\n`);
  }
  process.exit(exit);
}
