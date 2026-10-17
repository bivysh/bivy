// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy ask`: a question any agent raises through the shared QuestionManager,
// answered from the same card, waited on in slices, and readable afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import { QuestionManager } from "../src/question.js";
import { AgentQuestions, askQuestionsFrom } from "../src/session/agent-questions.js";

const items = [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }];

test("an answer from the card reaches a waiting caller, and stays readable", async () => {
  const manager = new QuestionManager();
  const asks = new AgentQuestions(manager);
  const raised: string[] = [];
  manager.onRequest((request) => raised.push(request.id));
  const { id } = asks.ask("s", items, 60_000);
  assert.deepEqual(raised, [id], "the card the UI renders carries the same id");
  const waiting = asks.wait("s", id, 5_000);
  manager.resolve(id, { behavior: "completed", answers: { "Which database?": "SQLite" } });
  assert.deepEqual(await waiting, { id, sessionId: "s", status: "answered", answers: { "Which database?": "SQLite" } });
  assert.equal(asks.get("s", id)?.status, "answered");
  assert.equal(asks.get("other-session", id), undefined, "another session can't read it");
});

test("a dismissed question and an expired one are told apart", async () => {
  const manager = new QuestionManager();
  const asks = new AgentQuestions(manager);
  const dismissed = asks.ask("s", items, 60_000);
  manager.resolve(dismissed.id, { behavior: "cancelled" });
  assert.equal((await asks.wait("s", dismissed.id, 1_000))?.status, "dismissed");
  const expired = asks.ask("s", items, 1_000);
  assert.equal((await asks.wait("s", expired.id, 3_000))?.status, "expired");
});

test("a wait slice that ends first reports the question still pending", async () => {
  const asks = new AgentQuestions(new QuestionManager());
  const { id } = asks.ask("s", items, 60_000);
  assert.equal((await asks.wait("s", id, 10))?.status, "pending");
});

test("a secret answer goes to the store and the agent reads back only its reference", async () => {
  const manager = new QuestionManager();
  const stored: Array<[string, string]> = [];
  const asks = new AgentQuestions(manager, Date.now, (name, value) => { stored.push([name, value]); });
  const [item] = askQuestionsFrom([{ question: "Stripe key?", secret: { name: "STRIPE_API_KEY" }, url: "https://dashboard.stripe.com/apikeys" }]) as never[];
  const { id } = asks.ask("s", [item], 60_000);
  manager.resolve(id, { behavior: "completed", answers: { "Stripe key?": " sk_live_abc123 " } });
  assert.deepEqual((await asks.wait("s", id, 1_000))?.answers, { "Stripe key?": "secret://STRIPE_API_KEY" });
  assert.deepEqual(stored, [["STRIPE_API_KEY", "sk_live_abc123"]]);

  const failing = new AgentQuestions(manager, Date.now, () => { throw new Error("vault locked"); });
  const second = failing.ask("s", [item], 60_000);
  manager.resolve(second.id, { behavior: "completed", answers: { "Stripe key?": "sk_live_abc123" } });
  assert.deepEqual((await failing.wait("s", second.id, 1_000))?.answers, { "Stripe key?": "" }, "a value that wasn't stored never reaches the agent");
});

test("ask input: free text needs no options; duplicates and empty asks are refused", () => {
  assert.deepEqual(askQuestionsFrom([{ question: "Release name?" }]), [{ question: "Release name?", header: "Question", options: [] }]);
  assert.equal(typeof askQuestionsFrom([{ question: "Ship?", options: ["Yes", "Yes"] }]), "string");
  assert.equal(typeof askQuestionsFrom([{ question: "Ship?", options: ["Yes"] }]), "string");
  assert.equal(typeof askQuestionsFrom([]), "string");
  assert.equal(typeof askQuestionsFrom([{ question: "Token?", secret: { name: "github.repo-token" } }]), "string", "a secret can't overwrite the node's own vault ids");
  assert.equal(typeof askQuestionsFrom([{ question: "Token?", secret: { name: "TOKEN" }, options: ["a", "b"] }]), "string");
  assert.deepEqual(askQuestionsFrom([{ question: "Signed in?", url: "https://github.com/login/device", code: " ABCD-1234 ", options: ["Done", "Failed"] }]), [{ question: "Signed in?", header: "Your step", options: [{ label: "Done" }, { label: "Failed" }], url: "https://github.com/login/device", code: "ABCD-1234" }]);
  assert.equal(typeof askQuestionsFrom([{ question: "Open?", url: "javascript:alert(1)" }]), "string", "a link the card opens must be https");
});
