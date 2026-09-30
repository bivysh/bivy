#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// bin/cli-commands.mjs is the one list of `bivy` commands. This keeps what
// can still drift from it in step:
//   - bin/bivy.mjs's dispatcher switches on exactly the table's canonical names
//     (an unlisted `case` is unreachable; a listed name without one throws);
//   - docs/cli-reference.md has a `### \`bivy <name>…\`` section for every
//     visible command (name or alias), so agents reading the docs see it all;
//   - every MCP tool's argv reads only inputs it declares, uses every one, and
//     starts with its own command; tool names are unique;
//   - every guide in bin/guides has a "# Title" and a "Summary:" line.

import { readFileSync, readdirSync } from "node:fs";
import { COMMANDS } from "../bin/cli-commands.mjs";

const cli = readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");
const reference = readFileSync(new URL("../docs/cli-reference.md", import.meta.url), "utf8");
const problems = [];

const main = cli.slice(cli.indexOf("async function main() {"), cli.indexOf("main().catch("));
const dispatched = new Set([...main.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]));
const names = new Set(COMMANDS.map((command) => command.name));
for (const name of names) if (!dispatched.has(name)) problems.push(`bin/cli-commands.mjs lists "${name}" but main() in bin/bivy.mjs has no case for it.`);
for (const name of dispatched) if (!names.has(name)) problems.push(`main() in bin/bivy.mjs dispatches "${name}", which bin/cli-commands.mjs does not list (add a row, or an alias to an existing row).`);

const headings = [...reference.matchAll(/^### `bivy ([^\s`]+)/gm)].map((m) => m[1]);
for (const command of COMMANDS) {
  if (command.hidden) continue;
  const words = [command.name, ...(command.aliases ?? [])];
  if (!headings.some((heading) => words.includes(heading))) problems.push(`docs/cli-reference.md has no "### \`bivy ${command.name} …\`" section.`);
}

const toolNames = new Set();
for (const command of COMMANDS) {
  for (const tool of command.tools ?? []) {
    if (toolNames.has(tool.name)) problems.push(`MCP tool "${tool.name}" is declared twice.`);
    toolNames.add(tool.name);
    if (tool.argv[0] !== command.name) problems.push(`MCP tool "${tool.name}" must run its own command, "${command.name}".`);
    const used = tool.argv.filter((part) => typeof part !== "string").map((part) => part.arg ?? part.from ?? part.when);
    for (const key of used) if (!(key in tool.input)) problems.push(`MCP tool "${tool.name}" reads "${key}", which its input does not declare.`);
    for (const key of Object.keys(tool.input)) if (!used.includes(key)) problems.push(`MCP tool "${tool.name}" declares input "${key}" but never passes it to the command.`);
  }
}

const guidesDir = new URL("../bin/guides/", import.meta.url);
for (const file of readdirSync(guidesDir).filter((name) => name.endsWith(".md"))) {
  const text = readFileSync(new URL(file, guidesDir), "utf8");
  if (!/^# .+$/m.test(text) || !/^Summary: .+$/m.test(text)) problems.push(`bin/guides/${file} needs a "# Title" line and a "Summary: …" line.`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`CLI table, dispatcher and reference agree (${COMMANDS.length} commands).`);
