import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import type { CredentialStore, ProviderCredential } from "../src/runtime/types.js";

// Regression: a running session's model picker used to show a different, staler
// catalog than a fresh session's. The picker's live list comes from the SDK's
// supportedModels(), which was captured once at spawn (frozen) and whose rows
// carry the SDK's bare labels ("Opus 4.8", "Sonnet") rather than the product
// names a fresh session shows via FALLBACK_MODELS ("Claude Opus 4.8"). The fix
// brands the live rows and re-queries on every getModels() so the list stays
// current. This drives that with a fake SDK whose supportedModels() we mutate.

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

const CLAUDE_BARE = new Set(["Opus", "Sonnet", "Haiku", "Fable", "Mythos"]);

// A minimal SDK query stand-in: async-iterable (never yields here) plus a
// mutable supportedModels() so we can prove the catalog is re-read, not frozen.
class FakeQuery {
  prompt?: QueueLike;
  models: any[];
  constructor(public readonly options: any, models: any[]) {
    this.models = models;
  }
  supportedModels(): Promise<any[]> {
    return Promise.resolve(this.models);
  }
  setModel(): void {}
  interrupt(): void {}
  close(): void {}
  [Symbol.asyncIterator](): AsyncIterator<any> {
    return { next: () => new Promise<IteratorResult<any>>(() => {}) };
  }
}

function makeSdk(models: any[]) {
  const queries: FakeQuery[] = [];
  const sdk = {
    query({ prompt, options }: { prompt: QueueLike; options: any }) {
      const q = new FakeQuery(options, models);
      q.prompt = prompt;
      queries.push(q);
      return q;
    },
  };
  return { sdk, queries };
}

// A vault holding an Anthropic OAuth token so prompt()'s credential preflight
// passes and the query actually spawns.
class TokenStore implements CredentialStore {
  async getCredential(): Promise<ProviderCredential | undefined> {
    return { provider: "anthropic", kind: "oauth", token: "tok" };
  }
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Before the query spawns: the curated fallback lineup, nicely named ──
{
  const runtime = new ClaudeCodeRuntime();
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const models = await session.getModels();
  assert.ok(models.length > 0, "a fresh session lists fallback models before the first prompt");
  assert.ok(models.some((m) => m.id === "claude-opus-4-8" && m.name === "Claude Opus 4.8"), "fallback uses product names");
  session.dispose();
  console.log("fallback catalog OK");
}

// ── After the query is up: the SDK's rows, branded to the product's names ──
{
  // The SDK's ModelInfo shape uses `value` (id) + `displayName` (label). Alias
  // rows ("Sonnet") and the default row have no version; concrete rows carry the
  // wire id. None should keep a bare, unbranded family label after normalization.
  const sdkModels = [
    { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-4-8" },
    { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
    { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5" },
    { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5" },
    { value: "fable", displayName: "Fable", resolvedModel: "claude-fable-5" },
    { value: "claude-opus-4-8", displayName: "Opus 4.8" },
  ];
  const { sdk, queries } = makeSdk(sdkModels);
  const runtime = new ClaudeCodeRuntime({ sdkLoader: async () => sdk, credentials: new TokenStore() });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  await session.prompt("go");
  await waitFor(() => queries.length === 1);

  const models = await session.getModels();
  const byName = new Map(models.map((m) => [m.id, m.name] as const));
  assert.equal(byName.get("claude-opus-4-8"), "Claude Opus 4.8", "the concrete Opus row matches the fresh-session name");
  assert.equal(byName.get("sonnet"), "Claude Sonnet", "the Sonnet alias is branded");
  assert.equal(byName.get("opus"), "Claude Opus", "the Opus alias is branded");
  assert.equal(byName.get("haiku"), "Claude Haiku", "the Haiku alias is branded");
  assert.equal(byName.get("fable"), "Claude Fable", "the Fable alias is branded");
  // "Default (recommended)" is a UX label, not a family — left untouched.
  assert.equal(byName.get("default"), "Default (recommended)", "the default row keeps its recommendation label");
  assert.ok(models.every((m) => !CLAUDE_BARE.has(m.name)), "no bare family label survives");

  // ── Unfreeze: mutating the SDK's list is reflected on the next getModels() ──
  queries[0].models = [{ value: "claude-mythos-5", displayName: "Mythos 5" }];
  const refreshed = await session.getModels();
  assert.deepEqual(refreshed.map((m) => m.name), ["Claude Mythos 5"], "getModels() re-queries instead of freezing the spawn-time list");

  session.dispose();
  console.log("branded + unfrozen catalog OK");
}

// ── warmModels(): a not-yet-prompted session fetches the real catalog ──
{
  const sdkModels = [
    { value: "claude-opus-5", displayName: "Opus 5" },
    { value: "claude-sonnet-5", displayName: "Sonnet 5" },
  ];
  const { sdk, queries } = makeSdk(sdkModels);
  const runtime = new ClaudeCodeRuntime({ sdkLoader: async () => sdk, credentials: new TokenStore() });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  // Before warming (no prompt sent) the picker shows the placeholder lineup.
  const before = await session.getModels();
  assert.ok(before.some((m) => m.id === "claude-opus-4-8"), "an un-warmed session shows the placeholder fallback");
  assert.equal(queries.length, 0, "reading the placeholder does not spawn an agent");

  // Warming spins up the agent just far enough to read the real, branded list.
  await session.warmModels();
  await waitFor(() => queries.length === 1);
  const after = await session.getModels();
  assert.deepEqual(after.map((m) => m.name), ["Claude Opus 5", "Claude Sonnet 5"], "warmModels() surfaces the live catalog, branded");

  session.dispose();
  console.log("warmModels catalog OK");
}

console.log("claude-code model catalog: all tests passed");
