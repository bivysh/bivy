// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { buildLinearTaskPrompt, getLinearIssue, linearBranchName } from "../src/linear-tasks.js";

assert.equal(linearBranchName("ENG-42"), "bivy/linear-eng-42");

let request: RequestInit | undefined;
const issue = await getLinearIssue("lin_api_key", "uuid-1", (async (_url: string | URL | Request, init?: RequestInit) => {
  request = init;
  return new Response(JSON.stringify({ data: { issue: { id: "uuid-1", identifier: "ENG-42", title: "Fix it", description: "Details", url: "https://linear.app/i" } } }), { status: 200 });
}) as typeof fetch);
assert.equal((request?.headers as Record<string, string>).authorization, "lin_api_key");
assert.equal(issue?.identifier, "ENG-42");
assert.match(buildLinearTaskPrompt(issue!), /open a pull request/i);
console.log("✓ linear task fetch, branch, and prompt");
