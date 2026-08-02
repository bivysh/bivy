import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import { setConfiguredAutoAttachToolImages, MAX_PASSIVE_IMAGES_PER_TURN } from "../src/harness/tool-image-attachments.js";
import type { CredentialStore, ProviderCredential } from "../src/runtime/types.js";

// Passively surfacing tool-produced images (src/runtime/claude-code.ts, issue
// #292): toolResultText already drops non-text tool_result content, so a
// Playwright/screenshot MCP tool's image would otherwise vanish silently. These
// tests drive fake SDK tool_result messages carrying `image` content blocks
// through the streaming loop and assert on the `tool_image` events it emits —
// gated on the opt-in config, and bounded per turn.

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

/** A controllable stand-in for the SDK's `query()` handle (see
 *  test/claude-code-reload.test.ts, which this harness mirrors). */
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

class FixedStore implements CredentialStore {
  async getCredential(): Promise<ProviderCredential | undefined> {
    return { provider: "anthropic", kind: "oauth", token: "tok-fixed" };
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

/** Emit a tool_use assistant turn followed by its tool_result echo, the shape
 *  the SDK produces for a completed tool call. `imageParts` become the
 *  tool_result's own `content` array entries of type "image"; pass [] for a
 *  text-only result. */
function emitToolCallWithResult(query: FakeQuery, toolUseId: string, toolName: string, imageParts: any[]): void {
  query.emit({
    type: "assistant",
    message: { model: "claude-opus-4-8", content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }] },
  });
  query.emit({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: imageParts }] },
  });
}

function base64Image(mimeType = "image/png", data = "AAAA"): any {
  return { type: "image", source: { type: "base64", media_type: mimeType, data } };
}

async function newSession() {
  const { sdk, queries } = makeSdk();
  const runtime = new ClaudeCodeRuntime({ credentials: new FixedStore(), sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const events: any[] = [];
  session.subscribe((e) => events.push(e));
  return { session, queries, events };
}

// ── Off by default: an image in a tool_result never surfaces without opt-in ──
{
  setConfiguredAutoAttachToolImages(undefined);
  delete process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES;
  const { session, queries, events } = await newSession();

  await session.prompt("take a screenshot");
  await waitFor(() => queries.length === 1);
  emitToolCallWithResult(queries[0], "tu1", "screenshot", [base64Image()]);
  await waitFor(() => events.some((e) => e.type === "tool_result"));

  assert.ok(!events.some((e) => e.type === "tool_image"), "no tool_image event without the opt-in gate");

  session.dispose();
  console.log("gate off by default OK");
}

// ── Enabled: an image in a tool_result becomes a tool_image event ──
{
  setConfiguredAutoAttachToolImages(true);
  const { session, queries, events } = await newSession();

  await session.prompt("take a screenshot");
  await waitFor(() => queries.length === 1);
  emitToolCallWithResult(queries[0], "tu1", "screenshot", [base64Image("image/png", "SGVsbG8=")]);
  await waitFor(() => events.some((e) => e.type === "tool_image"));

  const imageEvents = events.filter((e) => e.type === "tool_image");
  assert.equal(imageEvents.length, 1);
  assert.equal(imageEvents[0].toolUseId, "tu1");
  assert.equal(imageEvents[0].toolName, "screenshot");
  assert.equal(imageEvents[0].mimeType, "image/png");
  assert.equal(imageEvents[0].data, "SGVsbG8=");

  session.dispose();
  console.log("gate on surfaces tool_image OK");
}

// ── A URL-sourced image (not base64) is skipped, never fetched ──
{
  setConfiguredAutoAttachToolImages(true);
  const { session, queries, events } = await newSession();

  await session.prompt("take a screenshot");
  await waitFor(() => queries.length === 1);
  emitToolCallWithResult(queries[0], "tu1", "screenshot", [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }]);
  await waitFor(() => events.some((e) => e.type === "tool_result"));

  assert.ok(!events.some((e) => e.type === "tool_image"), "a url-sourced image block is not surfaced");

  session.dispose();
  console.log("url-sourced image skipped OK");
}

// ── Per-turn cap: a chatty tool result can't flood the transcript ──
{
  setConfiguredAutoAttachToolImages(true);
  const { session, queries, events } = await newSession();
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    await session.prompt("take many screenshots");
    await waitFor(() => queries.length === 1);
    const parts = Array.from({ length: MAX_PASSIVE_IMAGES_PER_TURN + 2 }, () => base64Image());
    emitToolCallWithResult(queries[0], "tu1", "screenshot", parts);
    await waitFor(() => events.filter((e) => e.type === "tool_image").length === MAX_PASSIVE_IMAGES_PER_TURN);

    // Give any over-cap emission a moment to (not) arrive before asserting the
    // final count — the cap must hold, not just "eventually reach the cap".
    await new Promise((r) => setTimeout(r, 20));
    const imageEvents = events.filter((e) => e.type === "tool_image");
    assert.equal(imageEvents.length, MAX_PASSIVE_IMAGES_PER_TURN, "exactly the per-turn cap of images is surfaced");
    assert.ok(warnings.some((args) => /dropped/i.test(String(args[0]))), "the drop is logged");
  } finally {
    console.warn = originalWarn;
  }

  session.dispose();
  console.log("per-turn image cap enforced OK");
}

// ── The budget resets between turns — a capped-out turn doesn't starve the next ──
{
  setConfiguredAutoAttachToolImages(true);
  const { session, queries, events } = await newSession();

  await session.prompt("first turn");
  await waitFor(() => queries.length === 1);
  const parts = Array.from({ length: MAX_PASSIVE_IMAGES_PER_TURN + 1 }, () => base64Image());
  emitToolCallWithResult(queries[0], "tu1", "screenshot", parts);
  await waitFor(() => events.filter((e) => e.type === "tool_image").length === MAX_PASSIVE_IMAGES_PER_TURN);
  queries[0].emit({ type: "result", subtype: "success" });
  await waitFor(() => events.some((e) => e.type === "agent_end"));

  // The credential store's token never changes, so prompt() reuses the same
  // query instead of respawning (see restartWithFreshCredential) — the second
  // turn's tool_result rides the same FakeQuery.
  await session.prompt("second turn");
  emitToolCallWithResult(queries[0], "tu2", "screenshot", [base64Image()]);
  await waitFor(() => events.filter((e) => e.type === "tool_image").length === MAX_PASSIVE_IMAGES_PER_TURN + 1);

  session.dispose();
  console.log("per-turn budget resets across turns OK");
}

setConfiguredAutoAttachToolImages(undefined);
console.log("claude-code tool images: all tests passed");
