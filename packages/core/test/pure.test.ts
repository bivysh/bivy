// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  b64,
  unb64,
  b64url,
  unb64url,
  createReplayGuard,
  frameMessages,
  createFrameReassembler,
  FRAME_CHUNK_BYTES,
  toHtml,
  inline,
  eventKind,
  isToolUseBlock,
  isToolResultBlock,
  toolName,
  linkPayloadFromText,
  base64UrlToJson,
} from "../src/index.js";

describe("base64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(unb64(b64(bytes)))).toEqual(Array.from(bytes));
  });
  it("round-trips base64url without padding", () => {
    const bytes = new Uint8Array([251, 252, 253, 254, 255]);
    const encoded = b64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(unb64url(encoded))).toEqual(Array.from(bytes));
  });
});

describe("replay guard", () => {
  it("rejects missing/old/replayed frames", () => {
    const accept = createReplayGuard({ replayWindowMs: 1000 });
    const now = Date.now();
    expect(accept({ ts: now, nonce: "a" })).toBe(true);
    expect(accept({ ts: now, nonce: "a" })).toBe(false); // replay
    expect(accept({ ts: now - 5000, nonce: "b" })).toBe(false); // too old
    expect(accept({ nonce: "c" })).toBe(false); // malformed
  });
});

describe("relay framing", () => {
  it("passes small payloads through as a single frame", () => {
    const frames = frameMessages("hello");
    expect(frames).toHaveLength(1);
    const env = JSON.parse(frames[0]!);
    expect(env).toEqual({ t: "frame", p: "hello" });
  });
  it("chunks and reassembles large payloads in order", () => {
    const payload = "x".repeat(FRAME_CHUNK_BYTES * 2 + 10);
    const frames = frameMessages(payload, () => "grp1").map((f) => JSON.parse(f));
    expect(frames.length).toBe(3);
    const reassemble = createFrameReassembler();
    let out: string | null = null;
    for (const env of frames) out = reassemble(env);
    expect(out).toBe(payload);
  });
  it("returns null on incomplete groups", () => {
    const reassemble = createFrameReassembler();
    expect(reassemble({ t: "frame", p: "a", fc: "g", fi: 0, fn: 2 })).toBeNull();
  });
});

describe("markdown", () => {
  it("renders headings, bold, and escapes html", () => {
    expect(toHtml("# Title")).toBe("<h1>Title</h1>");
    expect(inline("**bold** <script>")).toBe("<strong>bold</strong> &lt;script&gt;");
  });
  it("renders fenced code without interpreting markup", () => {
    expect(toHtml("```\n<b>&\n```")).toBe('<pre><code>&lt;b&gt;&amp;</code></pre>');
  });
  it("renders tables", () => {
    const html = toHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });
  it("renders a table that immediately follows a line of prose", () => {
    // Regression: a table with no blank line before it used to be swallowed
    // into the preceding paragraph and rendered as raw pipe text.
    const html = toHtml("Here are the results:\n| Check | Result |\n| --- | --- |\n| core | pass |");
    expect(html).toContain("<p>Here are the results:</p>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Check</th>");
    expect(html).toContain("<td>pass</td>");
    expect(html).not.toContain("| Check | Result |");
  });
  it("renders a table with single-dash dividers (GFM)", () => {
    const html = toHtml("| a | b |\n|-|-|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>2</td>");
  });
  it("still renders a fence as code, not stray backticks, when it isn't alone on its own line", () => {
    // Regression: parseBlocks() only recognizes a fence when the ``` marker
    // is alone on a physical line. If a fence ends up mid-paragraph (e.g.
    // upstream text lost the newlines that normally isolate it), inline()'s
    // single-backtick regex used to partially consume the ``` runs, leaving
    // stray literal backticks and one giant unstyled span. inline() now pulls
    // a fenced run out before the single-backtick pass so it still renders as
    // a real code block in that fallback case.
    const mangled = 'Use `cache: "reload"` to bypass the cache: ```js const CACHE_NAME = "v1"; ``` Let me know.';
    const html = inline(mangled);
    expect(html).toContain('<code>cache: "reload"</code>');
    expect(html).toContain('<pre><code class="language-js"> const CACHE_NAME = "v1"; </code></pre>');
    expect(html).not.toMatch(/`/);
  });
  it("renders a bare URL wrapped in bold/italic as a styled link, not stray asterisks", () => {
    // Regression: the bare-URL autolink regex's character class didn't exclude
    // `*`/`_`, so a trailing "**"/"__" closing a bold/italic span got greedily
    // swallowed into the URL match (and into its href). That left a lone
    // leading "**" with no partner for the bold regex to match, so the output
    // was literal "**" next to a link whose href/text were corrupted with a
    // trailing "**".
    const bold = inline("**https://github.com/bivysh/bivy/pull/243**");
    expect(bold).toBe(
      '<strong><a href="https://github.com/bivysh/bivy/pull/243" target="_blank" rel="noopener">https://github.com/bivysh/bivy/pull/243</a></strong>'
    );
    expect(bold).not.toContain("*");
    const italic = inline("*https://example.com/foo*");
    expect(italic).toBe('<em><a href="https://example.com/foo" target="_blank" rel="noopener">https://example.com/foo</a></em>');
    const underscoreBold = inline("__https://example.com/bar__");
    expect(underscoreBold).toBe(
      '<strong><a href="https://example.com/bar" target="_blank" rel="noopener">https://example.com/bar</a></strong>'
    );
  });
});

describe("tool activity", () => {
  it("classifies event kinds", () => {
    expect(eventKind({ type: "tool_call" })).toBe("start");
    expect(eventKind({ type: "tool.result" })).toBe("result");
    expect(eventKind({ type: "message_update" })).toBe("message_update");
  });
  it("classifies blocks and extracts names", () => {
    expect(isToolUseBlock({ type: "tool_use" })).toBe(true);
    expect(isToolResultBlock({ type: "tool_result" })).toBe(true);
    expect(toolName({ name: "Bash" })).toBe("bash");
  });
});

describe("linking", () => {
  it("decodes a base64url payload from a bare string or a URL hash", () => {
    const payload = { n: "node1", k: "key" };
    const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    expect(base64UrlToJson(encoded)).toEqual(payload);
    expect(linkPayloadFromText(`https://x/#${encoded}`)).toEqual(payload);
  });
});
