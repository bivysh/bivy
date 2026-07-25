// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { renderHistory } from "../src/store-render.js";

describe("renderHistory block interleaving", () => {
  it("keeps text → tool → text order within one assistant message (the Codex shape)", () => {
    // Regression for the observed ordering bug: an assistant message whose
    // content is [text, tool_use, tool_use, text] used to render as one merged
    // prose bubble with both tool cards hoisted ABOVE it. It must interleave.
    const entries = renderHistory([
      { role: "user", content: "Create test.text then rm test.text" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll make the temporary file, remove it, and verify." },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "touch test.text" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "rm test.text" } },
          { type: "text", text: "Created test.text, removed it, and verified it no longer exists." },
        ],
      },
    ]);

    // user, assistant(prose1), tool(t1), tool(t2), assistant(prose2)
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ role: "user" });
    expect(entries[1].tool).toBeUndefined();
    expect(entries[1].text).toContain("I'll make the temporary file");
    expect(entries[2].tool?.callId).toBe("t1");
    expect(entries[3].tool?.callId).toBe("t2");
    expect(entries[4].tool).toBeUndefined();
    expect(entries[4].text).toContain("Created test.text");

    // The two prose segments are NOT merged, and the tool cards sit BETWEEN them.
    expect(entries[1].text).not.toContain("Created test.text");
    expect(entries[4].text).not.toContain("I'll make the temporary file");
  });

  it("drops harness meta turns (interrupt marker, task-notification/system-reminder) from history", () => {
    // Defense-in-depth for transcripts persisted before the runtime-level filter
    // existed. The CLI writes these into its transcript for the model; they must
    // not render as chat bubbles. A real user message that merely *starts* with
    // "<div>" must survive.
    const entries = renderHistory([
      { role: "user", content: "[Request interrupted by user]" },
      { role: "user", content: "<task-notification><status>completed</status></task-notification>" },
      { role: "system", content: "<system-reminder>internal note</system-reminder>" },
      { role: "user", content: "<div> how do I center this?" },
      { role: "assistant", content: "You can use flexbox." },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: "user", text: "<div> how do I center this?" });
    expect(entries[1]).toMatchObject({ role: "assistant", text: "You can use flexbox." });
  });

  it("handles string content and text-only assistant messages unchanged", () => {
    const entries = renderHistory([{ role: "assistant", content: "just text" }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: "assistant", text: "just text" });
  });

  it("renders a tool with no surrounding prose as a single card", () => {
    const entries = renderHistory([
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "bash", input: { command: "ls" } }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].tool?.callId).toBe("x");
  });

  it("closes a tool_use whose tool_result is echoed inside a role:user message (the fork/reload shape)", () => {
    // Claude Code / pi persist tool results as tool_result blocks inside a
    // role:"user" message. A forked session is rebuilt purely from this
    // transcript (no live agent_end, no tool sidecar), so the result must be
    // paired here or the card spins forever.
    const entries = renderHistory([
      { role: "user", content: "run ls" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] },
    ]);
    const toolEntry = entries.find((e) => e.tool?.callId === "t1");
    expect(toolEntry?.tool?.status).toBe("done");
    expect(toolEntry?.tool?.result).toBe("file.txt");
    // The tool_result echo must NOT leak a stray empty user bubble.
    expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
  });
});
