#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// bin/cli-commands.mjs is the one list of `bivy` commands. This keeps the two
// places that can still drift from it in step:
//   - bin/bivy.mjs's dispatcher switches on exactly the table's canonical names
//     (an unlisted `case` is unreachable; a listed name without one throws);
//   - docs/cli-reference.md has a `### \`bivy <name>…\`` section for every
//     visible command (name or alias), so agents reading the docs see it all.

import { readFileSync } from "node:fs";
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

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`CLI table, dispatcher and reference agree (${COMMANDS.length} commands).`);
