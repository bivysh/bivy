// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { ELICITATION_TOOL, elicitationQuestions, elicitationResult, type ElicitationRequest } from "../src/elicitation.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import type { CredentialStore, ProviderCredential } from "../src/runtime/types.js";

// An MCP server's elicitation on Bivy's question card, and its answer back in
// MCP's shape. Codex's shim is covered in codex-shim-requests.test.ts.

const form: ElicitationRequest = {
  serverName: "deploy",
  message: "Where should it go?",
  requestedSchema: {
    type: "object",
    required: ["region", "replicas", "confirm"],
    properties: {
      region: { type: "string", title: "Region", oneOf: [{ const: "eu-1", title: "Europe" }, { const: "us-1", title: "US" }] },
      replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 5 },
      confirm: { type: "boolean", title: "Confirm" },
      tags: { type: "array", title: "Tags", items: { type: "string", enum: ["web", "api", "jobs"] } },
      note: { type: "string", title: "Note", description: "Anything to add" },
    },
  },
};

const questions = elicitationQuestions(form)!;
assert.deepEqual(questions.map((q) => [q.header, q.question, q.options.map((o) => o.label), q.multiSelect ?? false, q.optional ?? false, q.closed ?? false]), [
  ["deploy", "Where should it go? — Region", ["Europe", "US"], false, false, true],
  ["", "Replicas", [], false, false, false],
  ["", "Confirm", ["Yes", "No"], false, false, true],
  ["", "Tags (optional)", ["web", "api", "jobs"], true, true, true],
  ["Note (optional)", "Anything to add", [], false, true, false],
], "each field kind becomes the card's choice, text or multi-select question; the server's message heads the first; choices take no free text");

const answers = (values: string[]) => ({ behavior: "completed" as const, answers: Object.fromEntries(questions.map((q, i) => [q.question, values[i] ?? ""])) });
assert.deepEqual(elicitationResult(form, answers(["Europe", "3", "Yes", "web, jobs", ""])), {
  action: "accept",
  content: { region: "eu-1", replicas: 3, confirm: true, tags: ["web", "jobs"] },
}, "answers read back as typed values; an empty optional field is left out");
assert.deepEqual(elicitationResult(form, answers(["Europe", "9", "Yes"])), { action: "cancel" }, "a required answer the schema refuses cancels instead of sending it");
assert.deepEqual(elicitationResult(form, { behavior: "cancelled" }), { action: "decline" }, "Skip declines");
assert.deepEqual(elicitationResult(form, { behavior: "replied" }), { action: "cancel" }, "a reply in the chat cancels");

const page: ElicitationRequest = { serverName: "github", mode: "url", message: "Sign in to GitHub", url: "https://github.com/login/device" };
assert.deepEqual(elicitationQuestions(page), [{ question: "Sign in to GitHub", header: "github", options: [], url: "https://github.com/login/device" }], "a URL elicitation is a step card");
assert.deepEqual(elicitationResult(page, { behavior: "completed", answers: { "Sign in to GitHub": "Done" } }), { action: "accept" });
assert.equal(elicitationQuestions({ ...page, url: "javascript:alert(1)" }), null, "a link that isn't a web page is never shown");

const go: ElicitationRequest = { serverName: "db", message: "Drop the cache?", requestedSchema: { type: "object", properties: {} } };
assert.deepEqual(elicitationQuestions(go)?.[0].options.map((o) => o.label), ["Continue", "Decline"], "a form with no fields asks for a go-ahead");
assert.deepEqual(elicitationResult(go, { behavior: "completed", answers: { "Drop the cache?": "Decline" } }), { action: "decline" });

// The Claude SDK hands elicitations to onElicitation; the runtime raises them
// through the session's tool interceptor and returns its result.
class StaticStore implements CredentialStore {
  async getCredential(): Promise<ProviderCredential | undefined> {
    return { provider: "anthropic", kind: "oauth", token: "tok" };
  }
}
let options: any;
const sdk = {
  query(args: { options: any }) {
    options = args.options;
    return { supportedModels: async () => [], setModel() {}, interrupt() {}, close() {}, [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<any>>(() => {}) }) };
  },
};
const seen: Array<{ toolName: string; input: unknown }> = [];
const runtime = new ClaudeCodeRuntime({ credentials: new StaticStore(), sdkLoader: async () => sdk });
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: ({ toolName, input }) => {
    seen.push({ toolName, input });
    return { handled: true, result: "sent", elicitation: { action: "accept", content: { replicas: 2 } } };
  },
});
await session.prompt("go");
for (let i = 0; !options && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(await options.onElicitation(form, { signal: new AbortController().signal, requestId: "r1" }), { action: "accept", content: { replicas: 2 } });
assert.deepEqual(seen, [{ toolName: ELICITATION_TOOL, input: form }], "the request reaches the guardian as asked");
session.dispose();

console.log("elicitation: all tests passed");
