import { describe, expect, it } from "vitest";
import { handoffSeedOf } from "../src/handoff-seed.js";

describe("handoffSeedOf", () => {
  it("recognizes a cross-agent fork seed and its source agent", () => {
    const text = "I am continuing an existing Bivy session (forked from claude-code-sdk to Grok).\nSession: Demo\n\nRecent conversation:";
    expect(handoffSeedOf(text)).toEqual({ kind: "fork", from: "claude-code-sdk" });
  });

  it("recognizes an imported-session seed", () => {
    const text = "I am continuing a Codex session that was started outside Bivy and imported here.\nNative resume wasn't available";
    expect(handoffSeedOf(text)).toEqual({ kind: "import", from: "Codex" });
  });

  it("leaves ordinary prompts alone, even ones quoting a seed", () => {
    expect(handoffSeedOf("Why did it say: I am continuing an existing Bivy session (forked from a to b).")).toBeUndefined();
    expect(handoffSeedOf("")).toBeUndefined();
  });
});
