// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { selectAffected } from "../scripts/affected-tests.mjs";

const suites = readdirSync("test").filter(file => file.endsWith(".test.ts")).map(file => `test/${file}`);
const select = (...changed: string[]) => selectAffected(process.cwd(), suites, changed) as { all: boolean; selected: string[] };
// This file names the paths below, so it legitimately depends on each of them.
const others = (...changed: string[]) => select(...changed).selected.filter(suite => suite !== "test/affected-tests.test.ts");

test("a suite runs when a module it reaches through a spawned entrypoint changes", () => {
  // agent-cli.test.ts spawns path.join(root, "src", "agent-cli.ts") rather than importing it.
  assert.ok(select("src/agent-cli.ts").selected.includes("test/agent-cli.test.ts"));
});

test("a changed suite always selects itself", () => {
  assert.deepEqual(others("test/release-gates.test.ts"), ["test/release-gates.test.ts"]);
});

test("files outside every suite's closure select nothing", () => {
  assert.deepEqual(others("CODE_OF_CONDUCT.md"), []);
});

test("comments are not dependencies", () => {
  // src/runtime/types.ts mentions src/server.ts only in prose; if that counted,
  // nearly every suite would depend on the server.
  const server = select("src/server.ts").selected.length;
  assert.ok(server < suites.length / 4, `src/server.ts selected ${server}/${suites.length} suites`);
});

test("dependency, compiler and runner changes select every suite", () => {
  for (const file of ["pnpm-lock.yaml", "tsconfig.json", "scripts/run-tests.mjs", ".github/workflows/ci.yml"]) {
    const result = select(file);
    assert.equal(result.all, true, file);
    assert.equal(result.selected.length, suites.length);
  }
});
