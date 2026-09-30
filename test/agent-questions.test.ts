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

test("ask input: free text needs no options; duplicates and empty asks are refused", () => {
  assert.deepEqual(askQuestionsFrom([{ question: "Release name?" }]), [{ question: "Release name?", header: "Question", options: [] }]);
  assert.equal(typeof askQuestionsFrom([{ question: "Ship?", options: ["Yes", "Yes"] }]), "string");
  assert.equal(typeof askQuestionsFrom([{ question: "Ship?", options: ["Yes"] }]), "string");
  assert.equal(typeof askQuestionsFrom([]), "string");
});
