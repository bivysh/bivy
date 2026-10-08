// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The grammar for things an agent places INSIDE its chat message by writing
// them in the markdown, rather than out-of-band beside it.
//
// Three parties have to agree on it, byte for byte:
//
//   1. the renderer (packages/core/src/markdown.ts) turns each reference into an
//      EMPTY placeholder element carrying the reference as a data attribute;
//   2. the node (src/session/transcript-persistence.ts) finds the same
//      references in the raw message, resolves each one, and stores the bytes in
//      the content-addressed AttachmentStore under that same reference string;
//   3. the view (packages/web ChatView) looks the reference up in the entry's
//      resolved map and hydrates the placeholder.
//
// Those three live in two packages that deliberately do not import each other
// (src/ is the node; @bivy/core is the client library). The agreement used to be
// two copies of one regex kept in lock-step by comment — which silently diverges
// the moment someone edits one. This file is the single source instead: the node
// compiles THIS file through a symlink at src/session/message-components.ts, and
// scripts/check-module-boundaries.mjs fails if the two stop being one inode.
//
// Being compiled by both builds, it imports nothing at all.

/** How many components one message may resolve. A pathological or hostile
 *  message must not fan out into an unbounded number of file reads / outbound
 *  fetches, nor bloat the event log that replicates to a phone. */
export const MAX_COMPONENTS_PER_MESSAGE = 6;

/** Longest reference we will even look at. Generous enough for a signed CDN URL
 *  and far past any real workspace path, but a hard bound — it is also the
 *  repetition limit in the pattern below, which is what keeps matching linear. */
const MAX_REF_LENGTH = 2048;

/** Longest alt text we will match. Bounded for the same reason, not because a
 *  caption that long means anything. */
const MAX_ALT_LENGTH = 500;

/** Where a reference's bytes come from. */
export type ComponentOrigin = "remote" | "workspace";

export interface ImageReference {
  /** The exact reference string, as written in the message. This is the key
   *  under which every layer stores and looks up the resolved attachment, so it
   *  must be derived identically on both sides — hence `unescapeComponentRef`. */
  ref: string;
  origin: ComponentOrigin;
}

/**
 * Markdown image syntax. One literal, used by every caller here, so the "keep
 * these two regexes identical" hazard cannot come back.
 *
 * Deliberately matches ANY target, not just the ones we accept:
 * `classifyImageTarget` decides, and a target it rejects is left in the message
 * as the literal text the agent wrote. Matching narrowly instead would make a
 * rejected image silently vanish.
 *
 * Returned fresh per call: a shared `g`-flagged regex carries `lastIndex`
 * between calls, which is exactly the kind of cross-call state that makes two
 * consumers of one module disagree.
 *
 * Both repetitions are BOUNDED, and must stay that way. Unbounded `[^\]]*` and
 * `[^)\s]+` make matching quadratic in the message length: on input like
 * `![![![…` every `!` starts a match attempt that scans to the end of the
 * string. This runs on assistant message text — which a prompt injection or a
 * tool result echoed into a reply can shape — on the node, at every message
 * boundary. With fixed upper bounds each attempt costs at most a constant, so
 * the whole scan is linear. (CodeQL js/polynomial-redos flags the unbounded
 * form; it was flagging the shape this module inherited.)
 */
function imagePattern(): RegExp {
  return new RegExp(`!\\[([^\\]]{0,${MAX_ALT_LENGTH}})\\]\\(([^)\\s]{1,${MAX_REF_LENGTH}})\\)`, "g");
}

/**
 * Reverse the entity escaping `esc()` in markdown.ts applies to the whole
 * message before the image rule ever runs.
 *
 * Without this the two sides disagree for any reference containing `&`: the
 * renderer would key on `…?a=1&amp;b=2` while the node — which scans the raw
 * message text — keys on `…?a=1&b=2`, and the image never hydrates. (That
 * mismatch predates this module; it is fixed here because this is now the one
 * place that derives a reference key.) On already-raw text this is a no-op
 * unless the text literally contains an entity, in which case both sides
 * normalise it the same way and still agree.
 */
export function unescapeComponentRef(target: string): string {
  return String(target || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Decide what an image target means, or `null` to refuse it.
 *
 * `remote` targets are fetched BY THE NODE under its SSRF checks (see
 * src/session/inline-image-fetch.ts) — never by the viewer's browser.
 *
 * `workspace` targets are read from the session's working directory. This
 * function is NOT the security boundary for them: `planAttachment()`
 * (src/session/attach-to-chat.ts) is, because only it can resolve symlinks
 * against the real workspace root. What this does is refuse the obviously
 * hostile shapes up front, so an absolute path or a traversal never becomes a
 * map key or reaches the filesystem at all. Message text is agent-authored and
 * therefore reachable by prompt injection, so both layers earn their place.
 */
export function classifyImageTarget(target: string): ComponentOrigin | null {
  const t = String(target || "").trim();
  if (!t || t.length > MAX_REF_LENGTH) return null;
  if (t.startsWith("https://")) return "remote";
  // Every other scheme is refused. `http:` would be an unencrypted fetch,
  // `data:`/`blob:` smuggle bytes past the size and mime checks, `file:` reads
  // the node's disk outside any workspace, and `javascript:` is self-evident.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  if (t.startsWith("//")) return null; // protocol-relative URL
  if (t.startsWith("/") || t.startsWith("~")) return null; // absolute / home-relative
  if (t.startsWith("#")) return null; // in-page anchor
  if (t.includes("\\")) return null;
  if (t.split("/").some((segment) => segment === "..")) return null; // traversal
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(t)) return null;
  return "workspace";
}

/**
 * Every image reference a message makes, de-duplicated, in first-seen order and
 * capped at `limit`. Targets `classifyImageTarget` refuses are left out: they
 * are not components, they are prose.
 */
export function extractImageReferences(text: string, limit = MAX_COMPONENTS_PER_MESSAGE): ImageReference[] {
  if (!text) return [];
  const out: ImageReference[] = [];
  const seen = new Set<string>();
  for (const match of String(text).matchAll(imagePattern())) {
    const ref = unescapeComponentRef(match[2] ?? "");
    const origin = classifyImageTarget(ref);
    if (!origin || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, origin });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Replace each accepted image reference via `render`, leaving refused ones as
 * the literal text the agent wrote. The renderer uses this so the one pattern
 * above stays the only place image syntax is recognised.
 */
export function replaceImageReferences(
  text: string,
  render: (image: { alt: string; ref: string; origin: ComponentOrigin }) => string,
): string {
  return String(text || "").replace(imagePattern(), (whole, alt: string, target: string) => {
    const ref = unescapeComponentRef(target);
    const origin = classifyImageTarget(ref);
    if (!origin) return whole;
    return render({ alt: alt ?? "", ref, origin });
  });
}

// ---------------------------------------------------------------------------
// Components the agent places with a directive or a spec
//
// `![alt](path)` says "show this image here" and nothing else. The two forms
// below are how an agent says anything more — show this FILE, show this CSV as a
// table — without a second out-of-band channel per kind:
//
//   ::view{src=data/sales.csv}         point at something in the workspace
//   ```bivy … ```                      carry a small spec inline
//
// Both land as the same value, a ComponentPlacement, and both render through one
// table keyed by `kind`. Adding a kind is a row in that table, not another
// branch here. Anything this file cannot make sense of stays the text the agent
// wrote, because an agent WILL get the syntax wrong and a message must still
// read.
// ---------------------------------------------------------------------------

/** The info string that marks a fenced block as a component spec. */
export const COMPONENT_FENCE_LANG = "bivy";

/** Ceiling for one inline spec. A spec rides in the message and then in every
 *  rendered copy of it, so it is for a handful of values — a file is the right
 *  home for real data. Past this the fence stays an ordinary code block. */
export const MAX_COMPONENT_SPEC_CHARS = 16 * 1024;

/** Ceiling for a directive's attribute list, bounding the parse below. */
const MAX_ATTRS_CHARS = 512;

/** Leaf directives this grammar knows. `view` is the general one; a named leaf
 *  can be added later without touching the parser. */
const LEAF_NAMES = new Set(["view"]);

/** Which syntax asked for a reference. The node refuses non-image bytes for an
 *  `image` reference (a mistyped link must not become a chip) but allows them
 *  for a `view`, where showing a file is the whole point. */
export type ReferenceSyntax = "image" | "view";

export interface MessageReference {
  ref: string;
  origin: ComponentOrigin;
  syntax: ReferenceSyntax;
}

/** A component the agent placed, as the renderer needs it. Exactly one of
 *  `ref` / `spec` is set: a directive points at something, a fence carries it. */
export interface ComponentPlacement {
  /** Workspace reference, for a directive. */
  ref: string | null;
  /** Inline spec object, for a fence. */
  spec: Record<string, unknown> | null;
  /** The directive's remaining attributes (`height`, `caption`, …). */
  attrs: Record<string, string | true>;
}

/**
 * `{src=a/b.csv height=200 caption="Last quarter" #fig-1 .wide}` →
 * `{ src: "a/b.csv", height: "200", caption: "Last quarter", id: "fig-1", class: "wide" }`
 *
 * Every repetition is bounded (see imagePattern's note — this runs on the same
 * agent-authored text), and the whole list is length-capped, so a pathological
 * attribute string is refused rather than parsed slowly.
 */
export function parseAttrs(source: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const text = String(source || "").trim().replace(/^\{|\}$/g, "");
  if (!text || text.length > MAX_ATTRS_CHARS) return out;
  const re = /([#.]?[\w-]{1,64})(?:\s*=\s*(?:"([^"\n]{0,512})"|'([^'\n]{0,512})'|([^\s"'}]{1,512})))?/g;
  for (const m of text.matchAll(re)) {
    const key = m[1] ?? "";
    const value = m[2] ?? m[3] ?? m[4];
    if (key.startsWith("#")) out.id = key.slice(1);
    else if (key.startsWith(".")) out.class = out.class ? `${String(out.class)} ${key.slice(1)}` : key.slice(1);
    else if (key) out[key] = value === undefined ? true : value;
  }
  return out;
}

/**
 * A whole line that is a leaf directive, or null. Block-level by construction:
 * the directive must own its line, so a `::view{…}` written mid-sentence is
 * prose and a half-streamed one cannot render until its line is complete.
 *
 * `src` is validated as a WORKSPACE reference. A directive is not a link — it
 * names something Bivy has to read — so a remote URL is refused here even
 * though `![](https://…)` accepts one.
 */
export function parseComponentDirective(line: string): ComponentPlacement | null {
  const m = /^::([a-z][\w-]{0,31})[ \t]*(\{[^}\n]{0,512}\})?[ \t]*$/i.exec(String(line || ""));
  if (!m || !LEAF_NAMES.has((m[1] ?? "").toLowerCase())) return null;
  const { src, ...attrs } = parseAttrs(m[2] ?? "");
  const ref = typeof src === "string" ? unescapeComponentRef(src) : "";
  if (!ref || classifyImageTarget(ref) !== "workspace") return null;
  return { ref, spec: null, attrs };
}

/** True for the info string of a component fence (```bivy). */
export function isComponentFence(info: string): boolean {
  return String(info || "").trim().toLowerCase() === COMPONENT_FENCE_LANG;
}

/**
 * A component fence's body as a spec object, or null to leave the fence as an
 * ordinary code block — which is what an agent gets for malformed JSON, and is
 * strictly better than an error: the source stays readable and copyable.
 */
export function parseComponentSpec(body: string): Record<string, unknown> | null {
  const text = String(body || "").trim();
  if (!text || text.length > MAX_COMPONENT_SPEC_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * How a component is rendered, from its spec's own `type` or from the file it
 * points at. One table, so a new kind is a row here plus a row in the view
 * layer's registry — never a branch in the parser.
 *
 * Returns a kind string even for a kind this build cannot render; the registry
 * decides, and falls back visibly rather than dropping the component.
 */
export function componentKind(opts: { path?: string | null; mimeType?: string | null; spec?: Record<string, unknown> | null }): string {
  const declared = opts.spec?.type;
  if (typeof declared === "string" && declared.trim()) return declared.trim().toLowerCase();
  if (opts.spec) return "unknown";
  const mime = String(opts.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  // Everything else is a file the reader can open or download. Rows for richer
  // readings of a file — a CSV as a table, a notebook, a diff — belong here
  // alongside the renderer that can actually draw them. A row added early would
  // promise a kind the view layer has to decline, turning a useful download into
  // "this version cannot show that yet".
  return "file";
}

/**
 * Every reference a message makes that Bivy has to resolve — from image syntax
 * or from a directive — de-duplicated, in first-seen order, under ONE shared
 * cap. One budget across both forms is deliberate: the cost being bounded is
 * file reads and persisted bytes, which do not care which syntax asked.
 */
export function extractMessageReferences(text: string, limit = MAX_COMPONENTS_PER_MESSAGE): MessageReference[] {
  if (!text) return [];
  const source = String(text);
  const found: Array<MessageReference & { at: number }> = [];

  // Images are matched against the WHOLE text, not line by line: alt text may
  // contain a newline (an agent wrapping a long caption at 80 columns), and the
  // renderer — which sees a paragraph with its lines already joined — would
  // place a mount point the node then never resolved.
  for (const match of source.matchAll(imagePattern())) {
    const ref = unescapeComponentRef(match[2] ?? "");
    const origin = classifyImageTarget(ref);
    if (origin) found.push({ ref, origin, syntax: "image", at: match.index ?? 0 });
  }

  // Directives own a whole line, so they are matched per line; the running
  // offset keeps them in document order with the images above.
  let at = 0;
  for (const line of source.split("\n")) {
    const directive = parseComponentDirective(line);
    if (directive?.ref) found.push({ ref: directive.ref, origin: "workspace", syntax: "view", at });
    at += line.length + 1;
  }

  found.sort((a, b) => a.at - b.at);
  const out: MessageReference[] = [];
  const seen = new Set<string>();
  for (const { ref, origin, syntax } of found) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, origin, syntax });
    if (out.length >= limit) break;
  }
  return out;
}
