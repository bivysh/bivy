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
