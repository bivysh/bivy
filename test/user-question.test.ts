import assert from "node:assert/strict";
import { QuestionManager, validQuestions, isAskUserQuestionTool, formatQuestionResult } from "../src/question.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import type { CredentialStore, ProviderCredential, ToolInterceptor, UserQuestionItem } from "../src/runtime/types.js";

// Regression guard for AskUserQuestion — Bivy's interactive question card.
//
// This feature broke and was re-fixed repeatedly (#274, #305, #376, #386) while
// it rode Claude Code's *internal* SDK surface, which shifts between CLI
// releases. It broke again for the default `pi` runtime, which never had that
// SDK plumbing at all. The fix moves the whole feature OFF every runtime and
// into Bivy's guardian tool-interceptor (the one seam every runtime with
// capabilities.toolInterception already implements), so it works uniformly for
// pi, the Claude SDK, and any future agent. These tests lock that in.

let failures = 0;
async function scenario(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const QUESTION: UserQuestionItem = {
  question: "Which auth method?",
  header: "Auth method",
  options: [{ label: "OAuth" }, { label: "API key" }],
};

// ── Pure helpers ─────────────────────────────────────────────────────────────
await scenario("isAskUserQuestionTool matches case-insensitively across runtimes", () => {
  assert.ok(isAskUserQuestionTool("AskUserQuestion"));
  assert.ok(isAskUserQuestionTool("askuserquestion"));
  assert.ok(!isAskUserQuestionTool("Bash"));
});

await scenario("validQuestions rejects malformed shapes so a broken card never renders", () => {
  assert.deepEqual(validQuestions([QUESTION]), [QUESTION]);
  assert.equal(validQuestions([]), null, "empty array");
  assert.equal(validQuestions([{ question: "q", header: "h", options: [{ label: "one" }] }]), null, "needs >= 2 options");
  assert.equal(validQuestions([{ question: "q", header: "h" }]), null, "missing options");
  assert.equal(validQuestions("nope"), null, "non-array");
});

await scenario("formatQuestionResult states the answer plainly (not as an error)", () => {
  const done = formatQuestionResult([QUESTION], { behavior: "completed", answers: { "Which auth method?": "OAuth" } });
  assert.match(done, /Auth method: OAuth/);
  const skipped = formatQuestionResult([QUESTION], { behavior: "cancelled" });
  assert.match(skipped, /dismissed/i);
});

// ── QuestionManager: raise → answer, and the resolved fires once ─────────────
await scenario("request surfaces the question and resolves with the answer", async () => {
  const qm = new QuestionManager();
  const raised: string[] = [];
  const resolved: string[] = [];
  qm.onRequest((r) => raised.push(r.id));
  qm.onResolved((r) => resolved.push(r.id));

  const pending = qm.request({ sessionId: "s1", questions: [QUESTION] });
  await waitFor(() => raised.length === 1);
  assert.ok(qm.hasPendingForSession("s1"));

  assert.equal(qm.resolve(raised[0], { behavior: "completed", answers: { "Which auth method?": "OAuth" } }), true);
  assert.deepEqual(await pending, { behavior: "completed", answers: { "Which auth method?": "OAuth" } });
  assert.deepEqual(resolved, [raised[0]], "onResolved fires exactly once");
  assert.equal(qm.hasPendingForSession("s1"), false);
  assert.equal(qm.resolve(raised[0], { behavior: "cancelled" }), false, "a settled id is a silent no-op");
});

await scenario("skip resolves as cancelled", async () => {
  const qm = new QuestionManager();
  let id = "";
  qm.onRequest((r) => (id = r.id));
  const pending = qm.request({ sessionId: "s1", questions: [QUESTION] });
  await waitFor(() => id !== "");
  qm.resolve(id, { behavior: "cancelled" });
  assert.deepEqual(await pending, { behavior: "cancelled" });
});

await scenario("timeout auto-cancels a parked question", async () => {
  const qm = new QuestionManager();
  const pending = qm.request({ sessionId: "s1", questions: [QUESTION], timeoutMs: 20 });
  assert.deepEqual(await pending, { behavior: "cancelled" });
});

await scenario("aborting the turn settles the question immediately", async () => {
  const qm = new QuestionManager();
  const ac = new AbortController();
  const pending = qm.request({ sessionId: "s1", questions: [QUESTION], signal: ac.signal });
  await waitFor(() => qm.hasPendingForSession("s1"));
  ac.abort();
  assert.deepEqual(await pending, { behavior: "cancelled" });

  // Already-aborted signal never registers a pending entry.
  const pre = qm.request({ sessionId: "s2", questions: [QUESTION], signal: AbortSignal.abort() });
  assert.deepEqual(await pre, { behavior: "cancelled" });
  assert.equal(qm.hasPendingForSession("s2"), false);
});

await scenario("list() exposes pending questions per session for reconnect replay", async () => {
  // The server's replayPendingInteractions re-emits session.question for every
  // still-pending request when a client (re)opens a session — the fix for a
  // mobile client that missed the one-shot broadcast and would otherwise never
  // see the card until it timed out. It reads exactly this surface: list() must
  // return the live request with its sessionId and a "pending" status, and drop
  // it the moment it settles (so a resolved card is never replayed).
  const qm = new QuestionManager();
  const a = qm.request({ sessionId: "s1", questions: [QUESTION] });
  qm.request({ sessionId: "s2", questions: [QUESTION] });
  await waitFor(() => qm.list().length === 2);

  const forS1 = qm.list().filter((r) => r.sessionId === "s1");
  assert.equal(forS1.length, 1, "one pending question for s1");
  assert.equal(forS1[0].status, "pending");
  assert.deepEqual(forS1[0].questions, [QUESTION], "carries the payload the replay re-broadcasts");

  qm.resolve(forS1[0].id, { behavior: "completed", answers: { "Which auth method?": "OAuth" } });
  await a;
  assert.equal(qm.list().filter((r) => r.sessionId === "s1").length, 0, "a settled question is never replayed");
  assert.equal(qm.list().length, 1, "other sessions still pending");

  // Settle the remaining s2 question so its pending timeout doesn't keep the
  // test process alive (the manager's timers are not unref'd).
  qm.cancelForSession("s2");
});

await scenario("cancelForSession closes every card for a torn-down session", async () => {
  const qm = new QuestionManager();
  const a = qm.request({ sessionId: "s1", questions: [QUESTION] });
  const b = qm.request({ sessionId: "s1", questions: [QUESTION] });
  const other = qm.request({ sessionId: "s2", questions: [QUESTION] });
  await waitFor(() => qm.list().length === 3);
  qm.cancelForSession("s1");
  assert.deepEqual(await a, { behavior: "cancelled" });
  assert.deepEqual(await b, { behavior: "cancelled" });
  assert.ok(qm.hasPendingForSession("s2"), "other sessions are untouched");
  qm.cancelForSession("s2");
  await other;
});

// ── The guardian's branch: AskUserQuestion → handled result ──────────────────
// Mirrors src/server.ts guardianInterceptor's question branch so the end-to-end
// shape (intercept → card → answer → `handled` result) is locked independently
// of server wiring.
function questionInterceptor(qm: QuestionManager): ToolInterceptor {
  return async ({ sessionId, toolName, input, signal }) => {
    if (!isAskUserQuestionTool(toolName)) return;
    const questions = validQuestions((input as { questions?: unknown } | undefined)?.questions);
    if (!questions) return;
    const answer = await qm.request({ sessionId, questions, signal });
    return { handled: true, result: formatQuestionResult(questions, answer) };
  };
}

await scenario("interceptor answers AskUserQuestion with a handled result", async () => {
  const qm = new QuestionManager();
  const interceptor = questionInterceptor(qm);
  let id = "";
  qm.onRequest((r) => (id = r.id));

  const decision = interceptor({ sessionId: "s1", toolName: "AskUserQuestion", input: { questions: [QUESTION] } });
  await waitFor(() => id !== "");
  qm.resolve(id, { behavior: "completed", answers: { "Which auth method?": "OAuth" } });

  const result = await decision;
  assert.equal(result?.handled, true);
  assert.match(result?.result ?? "", /Auth method: OAuth/);
});

await scenario("interceptor ignores non-question tools and malformed questions", async () => {
  const qm = new QuestionManager();
  const interceptor = questionInterceptor(qm);
  assert.equal(await interceptor({ sessionId: "s1", toolName: "Bash", input: { command: "ls" } }), undefined);
  assert.equal(await interceptor({ sessionId: "s1", toolName: "AskUserQuestion", input: { questions: [] } }), undefined, "malformed → let it run un-intercepted");
});

// ── Adapter honoring: the Claude runtime feeds a `handled` result to the agent ─
class StaticStore implements CredentialStore {
  async getCredential(): Promise<ProviderCredential | undefined> {
    return { provider: "anthropic", kind: "oauth", token: "tok" };
  }
}
class FakeQuery {
  closed = false;
  constructor(public readonly options: any) {}
  supportedModels(): Promise<any[]> { return Promise.resolve([]); }
  setModel(): void {}
  interrupt(): void {}
  close(): void { this.closed = true; }
  [Symbol.asyncIterator](): AsyncIterator<any> {
    return { next: () => new Promise<IteratorResult<any>>(() => {}) };
  }
}

await scenario("claude-code canUseTool routes tools through the interceptor and honors handled/allow", async () => {
  const queries: FakeQuery[] = [];
  const sdk = { query({ options }: { options: any }) { const q = new FakeQuery(options); queries.push(q); return q; } };
  const qm = new QuestionManager();
  const interceptor = questionInterceptor(qm);
  const runtime = new ClaudeCodeRuntime({ credentials: new StaticStore(), sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd(), toolInterceptor: interceptor });
  await session.prompt("go");
  await waitFor(() => queries.length === 1);
  const { canUseTool } = queries[0].options;
  assert.equal(typeof canUseTool, "function");

  // AskUserQuestion → intercepted → answered → delivered as the tool result via
  // the only host-result channel canUseTool has (the deny message).
  let id = "";
  qm.onRequest((r) => (id = r.id));
  const decision = canUseTool("AskUserQuestion", { questions: [QUESTION] }, {});
  await waitFor(() => id !== "");
  qm.resolve(id, { behavior: "completed", answers: { "Which auth method?": "API key" } });
  const result = await decision;
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /Auth method: API key/);

  // A plain tool with no interceptor verdict is allowed to run.
  const allow = await canUseTool("Read", { file_path: "/x" }, {});
  assert.equal(allow.behavior, "allow");
  session.dispose();
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nuser-question: all tests passed");
