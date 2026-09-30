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
//   tools       MCP tools `bivy mcp-serve` offers for this command. Each maps
//               its input to CLI words (`argv`, below) and runs `bivy … --json`,
//               so a tool behaves exactly like the command. Only session
//               commands that are safe to call routinely get one; delegation
//               and Runs stay shell-only on purpose (docs/agent-delegation.md).
//
// A tool's `argv` is data: a literal word, {arg} (a positional value),
// {flag, from} (a flag with a value, repeated for arrays, joined with `join`),
// or {when, flag} (a bare switch when the input is true).

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
  { name: "context", group: "session", scope: "session", json: true, usage: "context [--json]", summary: "Where this agent is running: session, workspace, machine, apps, and what to run next",
    tools: [{ name: "bivy_context", description: "Where you are running inside Bivy: your session, agent, workspace and git branch, the machine, apps you have published, whether the user has the app open, and the commands that reach them.", input: {}, argv: ["context"] }] },
  { name: "attach", group: "session", scope: "session", json: true, usage: 'attach <file> [--caption "…"] [--artifact]', summary: "Show a local file or image to the user in the chat" },
  { name: "notify", group: "session", scope: "session", json: true, usage: 'notify "<message>" [--urgent]', summary: "Message the user: a card in the chat, and a push when they're away",
    tools: [{ name: "notify_user", description: "Send the user a message: a card in the chat, and a push to their phone when nobody has the app open (the push names the session, not the text). Use it when long work finishes, you are blocked, or something needs their attention. At most one push a minute per session.", input: { message: { type: "string", description: "What to tell the user.", required: true }, urgent: { type: "boolean", description: "Push even while the user has the app open." } }, argv: ["notify", { arg: "message" }, { when: "urgent", flag: "--urgent" }] }] },
  { name: "ask", group: "session", scope: "session", json: true, usage: 'ask "<question>" [--option A --option B] [--async]', summary: "Ask the user a question and wait for the answer", subcommands: ["status", "wait"],
    tools: [{ name: "ask_user", description: "Ask the user a question in the chat and wait for their answer (their phone gets a push). Offer 2-8 options, or none for a free-text answer; they can always write their own. Returns {status, answer}: status is answered, dismissed (decide yourself) or expired.", input: { question: { type: "string", description: "The question.", required: true }, options: { type: "array", items: { type: "string" }, description: "Choices to pick from (2-8)." }, multiple: { type: "boolean", description: "Allow several choices." }, header: { type: "string", description: "A short label for the card." }, timeout_seconds: { type: "number", description: "How long to wait (default 600)." } }, argv: ["ask", { arg: "question" }, { flag: "--option", from: "options" }, { when: "multiple", flag: "--multi" }, { flag: "--header", from: "header" }, { flag: "--timeout", from: "timeout_seconds" }] }] },
  { name: "suggest", group: "session", scope: "session", json: true, usage: 'suggest "<task>" [--title "label"]', summary: "Propose a task the user can start in one tap",
    tools: [{ name: "suggest_task", description: "Propose a next step the user can start in one tap, in this session or in a parallel one with its own copy of the project. Write the task as a complete instruction with paths relative to the project root. Post one per idea instead of listing them.", input: { task: { type: "string", description: "The complete instruction.", required: true }, title: { type: "string", description: "A short label for the card." } }, argv: ["suggest", { arg: "task" }, { flag: "--title", from: "title" }] }] },
  { name: "app", group: "session", scope: "session", json: true, usage: "app <publish|shot|present|share|run|…>", summary: "Live previews: publish a web/terminal/desktop app, screenshot it, present it", subcommands: ["publish", "list", "remove", "shot", "present", "share", "notes", "run", "click", "type", "key", "scroll", "drag", "move", "menu"],
    tools: [
      { name: "app_publish", description: "Give the user a live preview of something with a UI, from an app manifest file (web server port, static build, terminal, or desktop app). Run `bivy app --help` for the manifest format.", input: { manifest_path: { type: "string", description: "Path to the manifest JSON.", required: true } }, argv: ["app", "publish", { arg: "manifest_path" }] },
      { name: "app_screenshot", description: "Screenshot this session's web views (or one app) and return the PNG paths, to check your work before saying a UI change is done.", input: { app: { type: "string", description: "App ID or name (default: all web views)." }, widths: { type: "array", items: { type: "number" }, description: "Viewport widths, e.g. [390, 1280]." }, path: { type: "string", description: "Page path, e.g. /settings." } }, argv: ["app", "shot", { arg: "app" }, { flag: "--widths", from: "widths", join: "," }, { flag: "--path", from: "path" }] },
      { name: "app_present", description: "Tell the user a visible change is ready: a card in the chat with the app at phone width (before and after), and the preview opens.", input: { view: { type: "string", description: "App or view name or ID (default: the one opened last)." }, note: { type: "string", description: "What changed." }, path: { type: "string", description: "Page path to show." } }, argv: ["app", "present", { arg: "view" }, { flag: "--note", from: "note" }, { flag: "--path", from: "path" }] },
    ] },
  { name: "fork", group: "session", scope: "session", json: true, usage: "fork [session-id] [--model <model>]", summary: "Copy this session (conversation and uncommitted work) into a new one on its own branch" },
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
  { name: "approvals", group: "sessions", scope: "node", json: true, usage: "approvals [list|approve <id>|reject <id>]", summary: "List pending tool approvals on this node, or answer one", subcommands: ["list", "approve", "reject"] },
  { name: "issues", group: "sessions", scope: "node", json: true, usage: "issues [list|pickup <number>]", summary: "GitHub issues waiting for an agent; pick one up to start a session on it", subcommands: ["list", "pickup"] },
  { name: "agents", group: "sessions", scope: "node", json: true, usage: "agents [--json]", summary: "List supported agents and which are installed" },
  { name: "agent", group: "sessions", scope: "node", json: true, usage: "agent <add|list|remove>", summary: "Connect, list or remove a user-owned agent", subcommands: ["add", "list", "remove"] },
  { name: "agents:install", aliases: ["runtimes:install"], group: "sessions", scope: "node", usage: "agents:install [--bridges]", summary: "Install known upstream agents" },
  { name: "shim", aliases: ["listen"], group: "sessions", scope: "node", usage: "shim [install|uninstall|status] <agent>", summary: "Make typing '<agent>' open its TUI in a session the app can see", subcommands: ["install", "uninstall", "status"] },

  // Runs and automations
  { name: "runs", group: "runs", scope: "account", json: true, usage: 'runs <start|list|status|wait>', summary: "Unattended Runs with checks, evidence and a Receipt", subcommands: ["start", "list", "status", "wait"] },
  { name: "automation", aliases: ["automations"], group: "runs", scope: "account", json: true, usage: "automation <list|trigger|init|validate|plan|test|apply>", summary: "Automations as code: validate, plan, apply, trigger", subcommands: ["list", "trigger", "init", "validate", "plan", "test", "test-filter", "apply", "proposal"],
    tools: [
      { name: "automation_plan", description: "Check an automations file (.bivy/automations.yaml) and show what each automation would do: trigger, routing, effective safety. Run it before automation_apply.", input: { path: { type: "string", description: "The automations file (default .bivy/automations.yaml)." } }, argv: ["automation", "plan", { arg: "path" }] },
      { name: "automation_apply", description: "Propose applying an automations file to the user's account. They get an approval card listing each change; nothing is applied unless they approve. Returns the proposal: status applied, rejected, expired, failed, or pending (check later with bivy automation proposal <id> --wait).", input: { path: { type: "string", description: "The automations file (default .bivy/automations.yaml)." }, prune: { type: "boolean", description: "Also remove automations this file no longer has." } }, argv: ["automation", "apply", { arg: "path" }, { when: "prune", flag: "--prune" }] },
    ] },

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
  { name: "instructions", group: "config", scope: "account", json: true, usage: "instructions [show|set <file|->|path]", summary: "The account-wide instructions every agent session receives", subcommands: ["show", "set", "path"] },
  { name: "config", group: "config", scope: "node", json: true, usage: "config <show|get|set|unset|explain|validate|init|path>", summary: "Typed node configuration", subcommands: ["init", "validate", "show", "get", "set", "unset", "explain", "path"] },
  { name: "plugin", aliases: ["plugins"], group: "config", scope: "node", json: true, usage: "plugin <init|validate|doctor|test|install|list|remove>", summary: "Build and install plugins", subcommands: ["init", "validate", "doctor", "test", "install", "list", "remove"] },
  { name: "voice", aliases: ["stt"], group: "config", scope: "node", usage: "voice <provider|key|remove|status>", summary: "Configure speech-to-text", subcommands: ["provider", "key", "remove", "status"] },
  { name: "completions", aliases: ["completion"], group: "config", scope: "node", usage: "completions <bash|zsh|fish>", summary: "Print a shell completion script", subcommands: ["bash", "zsh", "fish"] },

  // Help and discovery
  { name: "guide", group: "help", scope: "node", json: true, usage: "guide [topic] [--json]", summary: "Short playbooks for agents: show the user, talk to them, long work, more hands, automate",
    tools: [{ name: "bivy_guide", description: "Short playbooks for working in Bivy. Without a topic, lists them.", input: { topic: { type: "string", description: "show-the-user, talk-to-the-user, long-work, more-hands or automate." } }, argv: ["guide", { arg: "topic" }] }] },
  { name: "help", aliases: ["-h", "--help"], group: "help", scope: "node", json: true, usage: "help [command] [--json]", summary: "Show this help, one command's row, or every command as JSON" },
  { name: "version", aliases: ["--version", "-v"], group: "help", scope: "node", usage: "version", summary: "Print the installed Bivy version" },

  // Plumbing
  { name: "tool", group: "help", scope: "session", hidden: true, json: true, usage: "tool <name> '<json input>'", summary: "Run one MCP tool (from `bivy help --json`) as its bivy command" },
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

/** A tool's input as JSON Schema. */
function toolSchema(input) {
  const properties = {};
  const required = [];
  for (const [key, { required: isRequired, ...schema }] of Object.entries(input)) {
    properties[key] = schema;
    if (isRequired) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** Every MCP tool, with its JSON Schema and argv template: what `bivy mcp-serve` offers. */
export function describeTools() {
  return COMMANDS.flatMap((command) => (command.tools ?? []).map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: toolSchema(tool.input), argv: tool.argv, command: command.name,
  })));
}

/** The `bivy` words for a tool call: argv template + the caller's input. */
export function toolArgv(argv, input = {}) {
  const words = [];
  for (const part of argv) {
    if (typeof part === "string") words.push(part);
    else if (part.arg) { if (input[part.arg] !== undefined && input[part.arg] !== "") words.push(String(input[part.arg])); }
    else if (part.when) { if (input[part.when] === true) words.push(part.flag); }
    else if (part.flag) {
      const value = input[part.from];
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && part.join) words.push(part.flag, value.join(part.join));
      else for (const item of Array.isArray(value) ? value : [value]) words.push(part.flag, String(item));
    }
  }
  return words;
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
    tools: describeTools(),
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
