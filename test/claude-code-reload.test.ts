import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import type { AgentCredentialStore, CredentialContext, ProviderCredential } from "../src/runtime/types.js";

// Mid-flight credential reload (src/runtime/claude-code.ts): a Claude Code query
// bakes its OAuth token into the subprocess env at spawn, so a long-lived turn
// that outlives the token 401s even though the vault holds a fresh one. These
// tests drive the reactive (retry-on-401) and proactive (turn-boundary) reloads
// with a fake SDK + a vault whose token we can rotate on demand.

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

/** A controllable stand-in for the SDK's `query()` handle: async-iterable (what
 *  the session consumes) plus emit()/fail()/close() the test drives. */
class FakeQuery {
  closed = false;
  prompt?: QueueLike;
  private events: Array<{ kind: "value"; value: any } | { kind: "done" } | { kind: "error"; error: unknown }> = [];
  private waiters: Array<{ resolve: (r: IteratorResult<any>) => void; reject: (e: unknown) => void }> = [];

  constructor(public readonly options: any) {}

  supportedModels(): Promise<any[]> {
    return Promise.resolve([]);
  }
  setModel(): void {}
  interrupt(): void {}
  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: undefined, done: true });
    else this.events.push({ kind: "done" });
  }
  emit(msg: any): void {
    const w = this.waiters.shift();
    if (w) w.resolve({ value: msg, done: false });
    else this.events.push({ kind: "value", value: msg });
  }
  fail(error: unknown): void {
    const w = this.waiters.shift();
    if (w) w.reject(error);
    else this.events.push({ kind: "error", error });
  }
  [Symbol.asyncIterator](): AsyncIterator<any> {
    const next = (): Promise<IteratorResult<any>> => {
      const ev = this.events.shift();
      if (ev) {
        if (ev.kind === "value") return Promise.resolve({ value: ev.value, done: false });
        if (ev.kind === "done") return Promise.resolve({ value: undefined, done: true });
        return Promise.reject(ev.error);
      }
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    };
    return { next };
  }
}

/** A vault whose Anthropic OAuth token can be rotated between resolutions, the way
 *  Pi's AuthStorage returns a freshly-refreshed token on each getApiKey(). */
class RotatingStore implements AgentCredentialStore {
  constructor(private token: string, private readonly refreshTo?: string) {}
  setToken(token: string): void {
    this.token = token;
  }
  async getCredential(_provider?: string, context?: CredentialContext): Promise<ProviderCredential | undefined> {
    if (this.refreshTo && context?.rejectedToken === this.token) this.token = this.refreshTo;
    return { provider: "anthropic", kind: "oauth", token: this.token };
  }
}

function makeSdk() {
  const queries: FakeQuery[] = [];
  const sdk = {
    query({ prompt, options }: { prompt: QueueLike; options: any }) {
      const q = new FakeQuery(options);
      q.prompt = prompt;
      queries.push(q);
      return q;
    },
  };
  return { sdk, queries };
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Read one value from a queue (the re-driven prompt) with a timeout so a missing
 *  re-push fails loudly instead of hanging the suite. */
async function nextWithin(queue: QueueLike, ms = 1000): Promise<any> {
  const it = queue[Symbol.asyncIterator]();
  return Promise.race([
    it.next().then((r) => r.value),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no prompt re-driven")), ms)),
  ]);
}

function tokenOf(q: FakeQuery): string | undefined {
  return q.options?.env?.CLAUDE_CODE_OAUTH_TOKEN;
}

// ── Reactive: a 401 mid-turn re-spawns with the refreshed token and re-drives ──
{
  const { sdk, queries } = makeSdk();
  const store = new RotatingStore("tok-stale");
  const runtime = new ClaudeCodeRuntime({ credentials: store, sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  const events: any[] = [];
  session.subscribe((e) => events.push(e));

  await session.prompt("do the thing");
  await waitFor(() => queries.length === 1);
  assert.equal(tokenOf(queries[0]), "tok-stale", "first spawn uses the current vault token");
  assert.equal(queries[0].options.sessionId, session.id, "a fresh session pins its id, not resume");

  // The vault refreshes (rotated OAuth token), then the in-flight turn 401s.
  store.setToken("tok-fresh");
  queries[0].fail(new Error("API Error: 401 Invalid authentication credentials"));

  await waitFor(() => queries.length === 2, 2000);
  assert.equal(queries[0].closed, true, "the stale query is torn down");
  assert.equal(tokenOf(queries[1]), "tok-fresh", "re-spawn uses the refreshed token");
  assert.equal(queries[1].options.resume, session.id, "re-spawn resumes the same session id");

  const redriven = await nextWithin(queries[1].prompt!);
  assert.equal(redriven?.message?.content, "do the thing", "the interrupted prompt is re-driven into the new query");

  assert.ok(
    events.some((e) => e.type === "session.notice" && /refreshing credentials/i.test(String(e.message))),
    "a 'Refreshing credentials…' notice is emitted on reload",
  );
  assert.ok(!events.some((e) => e.type === "session.error"), "no error surfaces once the reload succeeds");

  // The re-spawned turn completes normally.
  queries[1].emit({ type: "result", subtype: "success" });
  await waitFor(() => events.some((e) => e.type === "agent_end"));
  assert.ok(!events.some((e) => e.type === "session.error"), "a successful reloaded turn never reports an error");

  session.dispose();
  console.log("reactive reload OK");
}

// ── A revoked, unexpired token is force-refreshed without another message ──
{
  const { sdk, queries } = makeSdk();
  const store = new RotatingStore("tok-revoked", "tok-refreshed");
  const runtime = new ClaudeCodeRuntime({ credentials: store, sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  const events: any[] = [];
  session.subscribe((e) => events.push(e));

  await session.prompt("finish this turn");
  await waitFor(() => queries.length === 1);
  // Revoked OAuth failures commonly arrive as assistant text, not a thrown SDK
  // error. Recovery must intercept this shape before it reaches the transcript.
  queries[0].emit({
    type: "assistant",
    message: { content: [{ type: "text", text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked." }] },
  });

  await waitFor(() => queries.length === 2, 2000);
  assert.equal(tokenOf(queries[1]), "tok-refreshed", "the rejected token is refreshed immediately despite its stored expiry");
  assert.equal((await nextWithin(queries[1].prompt!))?.message?.content, "finish this turn", "the same turn continues automatically");
  assert.ok(!events.some((e) => e.type === "session.error"), "the recoverable 401 is not shown as a terminal error");

  session.dispose();
  console.log("revoked-token forced refresh OK");
}

// ── No fresher token: the 401 surfaces instead of looping ──
{
  const { sdk, queries } = makeSdk();
  const store = new RotatingStore("tok-stale"); // never rotates
  const runtime = new ClaudeCodeRuntime({ credentials: store, sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  const events: any[] = [];
  session.subscribe((e) => events.push(e));

  await session.prompt("do the thing");
  await waitFor(() => queries.length === 1);

  queries[0].fail(new Error("API Error: 401 Invalid authentication credentials"));
  await waitFor(() => events.some((e) => e.type === "session.error"), 2000);

  assert.equal(queries.length, 1, "no re-spawn when the vault has no fresher token");
  assert.ok(!events.some((e) => e.type === "session.notice"), "no reload notice when nothing was refreshed");
  const err = events.find((e) => e.type === "session.error");
  assert.match(String(err.error), /401/, "the underlying auth error is surfaced");

  session.dispose();
  console.log("no-fresh-token surfaces error OK");
}

// ── Proactive: a token rotated between turns is picked up before the next turn ──
{
  const { sdk, queries } = makeSdk();
  const store = new RotatingStore("tok-a");
  const runtime = new ClaudeCodeRuntime({ credentials: store, sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  const events: any[] = [];
  session.subscribe((e) => events.push(e));

  await session.prompt("first turn");
  await waitFor(() => queries.length === 1);
  queries[0].emit({ type: "result", subtype: "success" });
  await waitFor(() => events.some((e) => e.type === "agent_end"));

  // Vault rotates while idle; the next turn should restart onto the fresh token
  // before ever sending a request (no 401 needed).
  store.setToken("tok-b");
  await session.prompt("second turn");
  await waitFor(() => queries.length === 2, 2000);

  assert.equal(tokenOf(queries[1]), "tok-b", "the between-turns restart adopts the rotated token");
  assert.equal(queries[1].options.resume, session.id, "the proactive restart resumes the same session");
  assert.ok(
    events.some((e) => e.type === "session.notice" && /refreshing credentials/i.test(String(e.message))),
    "the proactive refresh also emits the notice",
  );

  session.dispose();
  console.log("proactive between-turn reload OK");
}

console.log("claude-code reload: all tests passed");
