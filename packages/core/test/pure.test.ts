// SPDX-License-Identifier: AGPL-3.0-only
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
  toHtml,
  inline,
  extractImageReferences,
  extractMessageReferences,
  classifyImageTarget,
  componentKind,
  isComponentFence,
  parseComponentDirective,
  parseComponentSpec,
  MAX_COMPONENTS_PER_MESSAGE,
  MAX_COMPONENT_SPEC_CHARS,
  eventKind,
  isToolUseBlock,
  isToolResultBlock,
  toolName,
  toolDetail,
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
  it("marks Mermaid fences for client-side diagram rendering", () => {
    expect(toHtml("```mermaid\nflowchart TD\n  A --> B\n```")).toBe(
      '<pre><code class="language-mermaid">flowchart TD\n  A --&gt; B</code></pre>',
    );
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
  it("renders a remote markdown image as an unresolved placeholder, not a fetchable src", () => {
    // #293: the deployed app's CSP (img-src 'self' data: blob:) blocks a literal
    // remote src outright, so the element must never carry one — the node
    // resolves data-md-ref to a blob: URL out of band (see ChatView).
    const html = inline("![a chart](https://example.com/chart.png)");
    expect(html).toBe('<img class="md-image" data-md-ref="https://example.com/chart.png" alt="a chart" loading="lazy">');
  });
  it("renders a workspace-relative image as a placeholder keyed by the path as written", () => {
    const html = inline("![a chart](./out/chart.png)");
    expect(html).toBe('<img class="md-image" data-md-ref="./out/chart.png" alt="a chart" loading="lazy">');
  });
  it("keys a reference by its raw text, not the escaped form the renderer sees", () => {
    // inline() esc()s the whole message before the image rule runs, so an `&`
    // in a reference arrives as `&amp;`. The node scans raw text, so a key
    // derived from the escaped form would never match what it stored.
    const html = inline("![c](https://example.com/c.png?a=1&b=2)");
    expect(html).toContain('data-md-ref="https://example.com/c.png?a=1&amp;b=2"');
    expect(html).not.toContain("&amp;amp;");
  });
  it("never renders a refused image target as an image", () => {
    // A refused target is prose, not a component. `http://` still falls through
    // to the link rule (unchanged behavior for non-https images); the rest have
    // no rule to match and stay the literal text the agent wrote.
    expect(inline("![a](http://x.test/a.png)")).not.toContain("<img");
    for (const target of ["/etc/passwd", "../../secrets.png", "data:image/png;base64,AAAA", "~/.ssh/id_rsa"]) {
      const html = inline(`![a](${target})`);
      expect(html, target).not.toContain("<img");
      expect(html, target).toContain("![a]");
    }
  });
  it("escapes alt text and the URL so neither can break out of the attribute", () => {
    const html = inline('![" onerror="alert(1)](https://example.com/x.png?a="b)');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

describe("extractImageReferences", () => {
  it("finds every distinct reference in first-seen order, with its origin", () => {
    const text = "![a](https://x.test/a.png) text ![b](out/b.png) ![a again](https://x.test/a.png)";
    expect(extractImageReferences(text)).toEqual([
      { ref: "https://x.test/a.png", origin: "remote" },
      { ref: "out/b.png", origin: "workspace" },
    ]);
  });
  it("ignores refused targets and plain links", () => {
    expect(extractImageReferences("![a](http://x.test/a.png) [link](https://x.test/page)")).toEqual([]);
  });
  it("caps one message at MAX_COMPONENTS_PER_MESSAGE across both origins", () => {
    const many = Array.from({ length: MAX_COMPONENTS_PER_MESSAGE + 4 }, (_, i) => `![i${i}](out/${i}.png)`).join(" ");
    expect(extractImageReferences(many)).toHaveLength(MAX_COMPONENTS_PER_MESSAGE);
  });
});

describe("image pattern matching stays linear", () => {
  it("scans an adversarial message in bounded time", () => {
    // js/polynomial-redos: with unbounded `[^\]]*` / `[^)\s]+`, every `!` in
    // `![![![…` starts an attempt that scans to the end of the string, so the
    // whole scan is quadratic. This text is agent-authored and reaches the node
    // at every message boundary, so a slow scan is reachable. Timing is a weak
    // assertion, but a quadratic scan of this input takes many seconds while a
    // linear one takes milliseconds — the two are orders of magnitude apart, so
    // a generous ceiling still fails loudly if a bound is ever dropped.
    const hostile = "![".repeat(60_000);
    const started = Date.now();
    expect(extractImageReferences(hostile)).toEqual([]);
    expect(extractImageReferences(`${hostile}](x.png)`).length).toBeLessThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("ignores an alt text or reference past its bound rather than matching slowly", () => {
    expect(extractImageReferences(`![${"a".repeat(600)}](out/x.png)`)).toEqual([]);
    expect(extractImageReferences(`![a](out/${"b".repeat(2100)}.png)`)).toEqual([]);
  });
});

describe("rendering a placed component", () => {
  it("renders a directive as an empty mount point carrying its reference and attributes", () => {
    const html = toHtml('::view{src=data/sales.csv caption="Last quarter"}');
    expect(html).toContain('class="md-component"');
    expect(html).toContain('data-md-ref="data/sales.csv"');
    expect(html).toContain("Last quarter");
    // Empty: what fills it needs bytes the node resolved or a React renderer.
    expect(html).toContain("></div>");
  });
  it("renders a bivy fence as a mount point carrying its spec", () => {
    const html = toHtml(['```bivy', '{"type":"metric","value":42}', '```'].join("\n"));
    expect(html).toContain('class="md-component"');
    expect(html).toContain("data-md-spec=");
    expect(html).not.toContain("<pre>");
  });
  it("leaves a malformed fence, and a directive written as prose, as readable source", () => {
    const bad = toHtml(["```bivy", "{nope", "```"].join("\n"));
    expect(bad).toContain("<pre>");
    expect(bad).toContain("{nope");
    expect(toHtml("talk about ::view{src=a.csv} inline")).not.toContain("md-component");
  });
  it("breaks a paragraph before a directive instead of swallowing it", () => {
    const html = toHtml("Here is the data.\n::view{src=data/sales.csv}");
    expect(html).toBe('<p>Here is the data.</p><div class="md-component" data-md-ref="data/sales.csv"></div>');
  });
  it("keeps a spec from breaking out of its attribute", () => {
    // The payload stays present as inert TEXT — that is the point of putting a
    // spec in an attribute rather than in markup. What must not survive is the
    // ability to close the attribute or open an element: both `"` and `<` are
    // escaped, so there is no second tag and no second attribute.
    const html = toHtml(['```bivy', '{"type":"metric","label":"<img src=x onerror=alert(1)>"}', '```'].join("\n"));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html.match(/<[a-z]+/gi)).toEqual(["<div"]);
  });
});

describe("component directives", () => {
  it("accepts a directive that owns its line and keeps its other attributes", () => {
    expect(parseComponentDirective('::view{src=data/sales.csv caption="Last quarter" #fig-1}')).toEqual({
      ref: "data/sales.csv",
      spec: null,
      attrs: { caption: "Last quarter", id: "fig-1" },
    });
  });
  it("allows surrounding and internal whitespace, in bounded time", () => {
    expect(parseComponentDirective("  ::view {src=a.csv}  ")?.ref).toBe("a.csv");
    // The failing path is the quadratic one: with two whitespace runs around
    // the optional brace group, a long run can be split between them in as many
    // ways as it is long. Trailing junk forces that path.
    const started = Date.now();
    expect(parseComponentDirective(`::a${"\t".repeat(50_000)}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("refuses a directive written as prose, or pointing anywhere but the workspace", () => {
    // Block-level by construction: mid-sentence is prose, and a half-streamed
    // line cannot render until it is complete.
    expect(parseComponentDirective("see ::view{src=a.csv} there")).toBeNull();
    expect(parseComponentDirective("::view{src=a.csv} trailing")).toBeNull();
    // A directive names something to read, so a URL is refused even though
    // image syntax accepts one.
    expect(parseComponentDirective("::view{src=https://x.test/a.csv}")).toBeNull();
    expect(parseComponentDirective("::view{src=/etc/passwd}")).toBeNull();
    expect(parseComponentDirective("::view{src=../../secrets.csv}")).toBeNull();
    expect(parseComponentDirective("::view{}")).toBeNull();
    expect(parseComponentDirective("::nope{src=a.csv}")).toBeNull();
  });
});

describe("component specs", () => {
  it("reads a JSON object body and leaves anything else to the code block", () => {
    expect(parseComponentSpec('{"type":"metric","value":3}')).toEqual({ type: "metric", value: 3 });
    // Malformed, non-object, and oversized bodies all fall back to a code
    // block, which keeps the source readable instead of showing an error.
    expect(parseComponentSpec("{nope")).toBeNull();
    expect(parseComponentSpec('["a"]')).toBeNull();
    expect(parseComponentSpec("")).toBeNull();
    expect(parseComponentSpec(`{"pad":"${"x".repeat(MAX_COMPONENT_SPEC_CHARS)}"}`)).toBeNull();
  });
  it("marks only the bivy info string as a component fence", () => {
    expect(isComponentFence("bivy")).toBe(true);
    expect(isComponentFence(" BIVY ")).toBe(true);
    expect(isComponentFence("json")).toBe(false);
    expect(isComponentFence("")).toBe(false);
  });
});

describe("componentKind", () => {
  it("prefers the spec's declared type, then the file's mime, then its extension", () => {
    expect(componentKind({ spec: { type: "Metric" } })).toBe("metric");
    expect(componentKind({ path: "a/b.png", mimeType: "image/png" })).toBe("image");
    expect(componentKind({ path: "a/b.csv" })).toBe("table");
    expect(componentKind({ path: "a/b.pdf", mimeType: "application/pdf" })).toBe("file");
  });
  it("recognises a Vega-Lite spec by its shape, with no type to remember", () => {
    // An agent's spec written for anywhere else has to work here unchanged;
    // requiring a Bivy-specific `type` would make it a dialect.
    expect(componentKind({ spec: { mark: "bar", encoding: {} } })).toBe("chart");
    expect(componentKind({ spec: { $schema: "https://vega.github.io/schema/vega-lite/v6.json" } })).toBe("chart");
    expect(componentKind({ spec: { layer: [] } })).toBe("chart");
    // An explicit type still wins, so a future kind can use any of those words.
    expect(componentKind({ spec: { type: "metric", mark: "bar" } })).toBe("metric");
  });
  it("names an unreadable spec rather than guessing a kind for it", () => {
    expect(componentKind({ spec: { value: 1 } })).toBe("unknown");
  });
});

describe("extractMessageReferences", () => {
  it("collects image and directive references in document order under one cap", () => {
    const text = ["![a](out/a.png)", "::view{src=data/b.csv}", "![c](https://x.test/c.png)"].join("\n");
    expect(extractMessageReferences(text)).toEqual([
      { ref: "out/a.png", origin: "workspace", syntax: "image" },
      { ref: "data/b.csv", origin: "workspace", syntax: "view" },
      { ref: "https://x.test/c.png", origin: "remote", syntax: "image" },
    ]);
  });
  it("finds an image whose alt text wraps across lines", () => {
    // The renderer sees a paragraph with its lines already joined, so scanning
    // line by line here would place a mount point nothing ever resolved.
    expect(extractMessageReferences("![a long\ncaption](out/a.png)")).toEqual([
      { ref: "out/a.png", origin: "workspace", syntax: "image" },
    ]);
  });
  it("resolves a path written both ways once, keeping the stricter image rule", () => {
    const both = "![a](out/a.png)\n::view{src=out/a.png}";
    expect(extractMessageReferences(both)).toEqual([{ ref: "out/a.png", origin: "workspace", syntax: "image" }]);
  });
});

describe("classifyImageTarget", () => {
  it("accepts https URLs and workspace-relative paths", () => {
    expect(classifyImageTarget("https://x.test/a.png")).toBe("remote");
    expect(classifyImageTarget("out/a.png")).toBe("workspace");
    expect(classifyImageTarget("./out/a.png")).toBe("workspace");
    expect(classifyImageTarget("a.png")).toBe("workspace");
  });
  it("refuses anything that is not one of those two", () => {
    // Not the security boundary — planAttachment is (symlink-resolved
    // confinement) — but a hostile target must never become a key or a read.
    for (const target of [
      "", "   ",
      "http://x.test/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "file:///etc/passwd",
      "//x.test/a.png", "/etc/passwd", "~/.ssh/id_rsa", "#section",
      "../../../etc/passwd", "out/../../etc/passwd", "out\\a.png",
      "out/\u0000a.png",
      `${"a".repeat(2100)}.png`,
    ]) {
      expect(classifyImageTarget(target), target).toBeNull();
    }
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
  it("preserves normalized delegation detail for sub-agent activity", () => {
    expect(toolDetail({ detail: { kind: "delegation", label: "Explore", description: "trace auth" } })).toEqual({
      kind: "delegation",
      label: "Explore",
      description: "trace auth",
    });
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
