import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCommandMarkdown,
  expandCommandBody,
  markdownSlashCommands,
  mergeAgentCommands,
} from "../src/runtime/slash-commands.js";

// Filesystem-sourced slash commands for Codex/opencode: parse a command markdown
// file, expand it against args, discover a dir as AgentCommand[], and merge with
// hello-advertised commands. Everything is best-effort — a missing dir is [].

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// --- parseCommandMarkdown ---------------------------------------------------

test("parseCommandMarkdown reads frontmatter description and strips it from body", () => {
  const { description, body } = parseCommandMarkdown(
    "---\ndescription: Review a file\nagent: build\n---\nReview $ARGUMENTS carefully.\n",
  );
  assert.equal(description, "Review a file");
  assert.equal(body, "Review $ARGUMENTS carefully.");
});

test("parseCommandMarkdown falls back to the first non-empty line, markers stripped", () => {
  const { description, body } = parseCommandMarkdown("# Summarize\n\nSummarize the diff.\n");
  assert.equal(description, "Summarize");
  assert.equal(body, "# Summarize\n\nSummarize the diff.");
});

test("parseCommandMarkdown handles quoted descriptions and long truncation", () => {
  assert.equal(parseCommandMarkdown('---\ndescription: "Quoted"\n---\nx').description, "Quoted");
  const long = "a".repeat(200);
  const desc = parseCommandMarkdown(`${long}`).description ?? "";
  assert.equal(desc.length, 80); // 79 chars + ellipsis
  assert.ok(desc.endsWith("…"));
});

// --- expandCommandBody ------------------------------------------------------

test("expandCommandBody substitutes $ARGUMENTS and positional $1..$9", () => {
  assert.equal(expandCommandBody("Fix $1 in $2", "app.ts fast"), "Fix app.ts in fast");
  assert.equal(expandCommandBody("Do: $ARGUMENTS", "a b c"), "Do: a b c");
  // Missing positional → empty.
  assert.equal(expandCommandBody("[$1][$2]", "only"), "[only][]");
});

test("expandCommandBody appends unused args when the body has no placeholder", () => {
  assert.equal(expandCommandBody("Run the linter.", "src/"), "Run the linter.\n\nsrc/");
  // No args and no placeholder → the body unchanged (trimmed).
  assert.equal(expandCommandBody("Just do it.\n", ""), "Just do it.");
});

// --- markdownSlashCommands: discovery + expansion ---------------------------

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("markdownSlashCommands lists *.md as sorted /name commands with descriptions", () => {
  const dir = tmpdir("bivy-slash-");
  fs.writeFileSync(path.join(dir, "review.md"), "---\ndescription: Review it\n---\nReview $ARGUMENTS");
  fs.writeFileSync(path.join(dir, "audit.md"), "Audit the code.");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored, not markdown");
  const provider = markdownSlashCommands({ dirs: () => [dir] });
  assert.deepEqual(provider.list("/anywhere"), [
    { name: "/audit", description: "Audit the code." },
    { name: "/review", description: "Review it" },
  ]);
});

test("markdownSlashCommands: a later dir shadows an earlier one on name collision", () => {
  const globalDir = tmpdir("bivy-slash-global-");
  const projectDir = tmpdir("bivy-slash-project-");
  fs.writeFileSync(path.join(globalDir, "deploy.md"), "GLOBAL deploy");
  fs.writeFileSync(path.join(projectDir, "deploy.md"), "PROJECT deploy $ARGUMENTS");
  const provider = markdownSlashCommands({ dirs: () => [globalDir, projectDir] });
  // list() surfaces one /deploy; expand() uses the project (later) file.
  assert.deepEqual(provider.list("x").map((c) => c.name), ["/deploy"]);
  assert.equal(provider.expand("x", "/deploy staging"), "PROJECT deploy staging");
});

test("markdownSlashCommands namespaces subdirectory files with '/'", () => {
  const dir = tmpdir("bivy-slash-nested-");
  fs.mkdirSync(path.join(dir, "git"));
  fs.writeFileSync(path.join(dir, "git", "commit.md"), "Commit $ARGUMENTS");
  const provider = markdownSlashCommands({ dirs: () => [dir] });
  assert.deepEqual(provider.list("x").map((c) => c.name), ["/git/commit"]);
  assert.equal(provider.expand("x", "/git/commit -m wip"), "Commit -m wip");
});

test("markdownSlashCommands.expand returns undefined for non-commands and unknown names", () => {
  const dir = tmpdir("bivy-slash-x-");
  fs.writeFileSync(path.join(dir, "known.md"), "Known $ARGUMENTS");
  const provider = markdownSlashCommands({ dirs: () => [dir] });
  assert.equal(provider.expand("x", "hello world"), undefined); // not a slash line
  assert.equal(provider.expand("x", "/unknown foo"), undefined); // no such command
  assert.equal(provider.expand("x", "/usr/local/bin"), undefined); // path-like, not a command
  assert.equal(provider.expand("x", "/known do it"), "Known do it"); // real command works
});

test("markdownSlashCommands degrades to [] for a missing directory", () => {
  const provider = markdownSlashCommands({ dirs: () => [path.join(os.tmpdir(), "does-not-exist-bivy-xyz")] });
  assert.deepEqual(provider.list("x"), []);
  assert.equal(provider.expand("x", "/whatever"), undefined);
});

// --- mergeAgentCommands -----------------------------------------------------

test("mergeAgentCommands: earlier group wins a name collision, order preserved", () => {
  assert.deepEqual(
    mergeAgentCommands(
      [{ name: "/a", description: "disk a" }, { name: "/b" }],
      [{ name: "/b", description: "hello b" }, { name: "/c" }],
    ),
    [{ name: "/a", description: "disk a" }, { name: "/b" }, { name: "/c" }],
  );
  assert.deepEqual(mergeAgentCommands(undefined, undefined), []);
});

console.log(`slash-commands: all ${passed} tests passed`);
