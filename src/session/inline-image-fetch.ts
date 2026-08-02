// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Fetch + validate a remote image an agent referenced with markdown image syntax
// (`![alt](https://…)`), so the node — not the viewer's browser — makes the
// request. See docs/issue #293: the deployed web app's CSP (`img-src 'self'
// data: blob:`) blocks a literal `<img src="https://…">` outright, so without
// this the syntax rendered nothing. Fetching server-side also closes the
// SSRF/privacy hole a client-side fetch would otherwise open (an agent could
// otherwise get the *viewer's* browser/IP to hit an arbitrary URL by embedding
// it in a reply).
//
// This is the PURE-ish, testable half — URL extraction, host/SSRF validation,
// and the guarded fetch itself — all dependency-injectable so tests never hit
// the real network or DNS. The server half (src/server.ts) owns the AttachmentStore
// write, the durable event-log ref, and the live broadcast; see resolveInlineImages.

import dns from "node:dns/promises";

import { hostnameIsLocal } from "../auth.js";
import { sanitizeAttachmentName, sniffMime } from "./attach-to-chat.js";

/**
 * The image-markdown pattern, `![alt](https://…)` — MUST match the image regex
 * in `inline()` in packages/core/src/markdown.ts exactly. Not a shared import: the
 * node (src/) intentionally does not depend on @bivy/core (a browser/client
 * package — see packages/core's own description). Kept in lock-step by comment
 * instead, the same convention EPHEMERAL_ALLOWED_HOSTS uses in
 * src/ephemeral-exec.ts for its cross-copy host allowlist. If you change one,
 * change the other.
 */
const INLINE_IMAGE_MD_RE = /!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g;

/** Bound how many distinct remote images a single message can trigger a fetch
 *  for — a pathological/malicious message can't fan out into an unbounded
 *  number of outbound requests. */
export const MAX_INLINE_IMAGES_PER_MESSAGE = 6;

/** Ceiling for a single fetched inline image. Smaller than
 *  MAX_AGENT_ATTACHMENT_BYTES (attach-to-chat.ts) because these bytes come from
 *  an arbitrary, untrusted remote origin rather than the local workspace —
 *  still comfortably under the relay's 32 MiB reassembly limit (see
 *  packages/core/src/wire-format.ts). */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;

/** Hard cap on redirect hops, mirroring execEphemeralRequest's guard. */
const MAX_REDIRECTS = 5;

/** Extract the distinct `https://` URLs a message's raw markdown references via
 *  `![alt](url)`, in first-seen order, capped at MAX_INLINE_IMAGES_PER_MESSAGE. */
export function extractInlineImageUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_IMAGE_MD_RE)) {
    const url = match[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_INLINE_IMAGES_PER_MESSAGE) break;
  }
  return out;
}

/** Best-effort plain text for an assistant RuntimeMessage's `content`, which is
 *  either a plain string or an array of typed blocks (`{type:"text", text}`
 *  among others, e.g. tool_use/thinking). Only the text parts matter for
 *  finding markdown image references. */
export function assistantTextForImageScan(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && String((part as Record<string, unknown>).type || "").toLowerCase() === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

/** Env-configurable extra allowlist, comma-separated hostnames — same shape/
 *  naming convention as BIVY_ALLOWED_HOSTS (src/auth.ts). When set and
 *  non-empty, ONLY these hosts may be fetched (a stricter opt-in for locked-down
 *  deployments); unset means "any public host is fine" (the private/local-address
 *  block below still applies either way). */
function explicitAllowlist(): Set<string> {
  return new Set(
    (process.env.BIVY_INLINE_IMAGE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface InlineImageFetchOptions {
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver — returns every address a hostname resolves to.
   *  Defaults to `dns.lookup(host, { all: true })`. Tests inject a fake so they
   *  never hit real DNS, and so a loopback test server can be exercised without
   *  it being rejected as a "private host". */
  resolveHost?: (hostname: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedImage {
  bytes: Buffer;
  mimeType: string;
}

export interface FetchImageError {
  error: string;
}

export function isFetchImageError(value: FetchedImage | FetchImageError): value is FetchImageError {
  return typeof (value as FetchImageError).error === "string";
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * Reject anything but a public https host before it's ever requested: the
 * literal hostname (an IP-literal `https://169.254.169.254/…` cloud-metadata
 * URL, or an internal domain), AND every address it resolves to (a public-
 * looking hostname an attacker points at an internal IP — classic DNS-rebinding
 * SSRF). This runs again on every redirect hop in fetchInlineImage, exactly like
 * execEphemeralRequest's per-hop host re-check.
 *
 * Known limitation: `fetch()` below does its own DNS resolution, which could in
 * principle differ from what we just checked (a narrow TOCTOU window) — pinning
 * the connection to the resolved address would need a custom dispatcher/Agent,
 * which isn't worth the complexity here; this closes the overwhelming majority
 * of real SSRF attempts (metadata endpoints, LAN scanning, loopback) the same
 * way the rest of this codebase's SSRF guards do.
 */
async function assertHostAllowed(url: URL, resolveHost: (hostname: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "https:") throw new Error(`Refusing to fetch a non-https image URL (${url.protocol})`);
  const hostname = url.hostname;
  if (hostnameIsLocal(hostname)) throw new Error(`Refusing to fetch an image from a local/private host: ${hostname}`);
  const allowlist = explicitAllowlist();
  if (allowlist.size > 0 && !allowlist.has(hostname.toLowerCase())) {
    throw new Error(`Host not in BIVY_INLINE_IMAGE_ALLOWED_HOSTS: ${hostname}`);
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    throw new Error(`Could not resolve host ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!addresses.length) throw new Error(`Host ${hostname} did not resolve to any address`);
  for (const address of addresses) {
    if (hostnameIsLocal(address)) throw new Error(`Refusing to fetch an image — ${hostname} resolves to a private/local address`);
  }
}

/**
 * Fetch a single remote image, guarded against SSRF (private/local hosts,
 * DNS-rebinding, unvalidated redirects), unbounded size, and non-image
 * responses. Returns the bytes + a validated mime type, or a human-readable
 * error — never throws (a bad/malicious URL must not crash the caller).
 */
export async function fetchInlineImage(rawUrl: string, opts: InlineImageFetchOptions = {}): Promise<FetchedImage | FetchImageError> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const maxBytes = opts.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `Invalid image URL: ${rawUrl}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      try {
        await assertHostAllowed(url, resolveHost);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }

      let res: Response;
      try {
        res = await fetchImpl(url.toString(), { signal: controller.signal, redirect: "manual", headers: { accept: "image/*" } });
      } catch (error) {
        return { error: `Fetching image failed: ${error instanceof Error ? error.message : String(error)}` };
      }

      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        if (hop >= MAX_REDIRECTS) return { error: `Too many redirects fetching image: ${rawUrl}` };
        const location = res.headers.get("location");
        if (!location) return { error: `Redirect (${res.status}) had no Location header` };
        try {
          url = new URL(location, url);
        } catch {
          return { error: `Redirect target was not a valid URL: ${location}` };
        }
        continue; // next hop re-validates the new host before requesting it
      }

      if (!res.ok) return { error: `Image fetch failed: HTTP ${res.status}` };

      const contentLength = Number(res.headers.get("content-length") || "0");
      if (contentLength > 0 && contentLength > maxBytes) {
        return { error: `Image too large (${contentLength} bytes; limit ${maxBytes})` };
      }
      if (!res.body) return { error: "Image response had no body" };

      const contentType = (res.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // best-effort — we're already erroring out
          }
          return { error: `Image exceeded the ${maxBytes}-byte limit` };
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      if (!bytes.length) return { error: "Image response was empty" };

      // Trust magic bytes over the (spoofable) Content-Type header when they
      // disagree; fall back to the header only when sniffing is inconclusive
      // (e.g. an SVG, which sniffMime doesn't recognize).
      const sniffed = sniffMime(bytes);
      const mimeType = sniffed || (contentType.startsWith("image/") ? contentType : "");
      if (!mimeType) return { error: "Response does not look like an image" };

      return { bytes, mimeType };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** A display name for a fetched inline image's AttachmentStore entry: the URL's
 *  last path segment when it looks like a filename, else a generic name derived
 *  from the resolved mime type. */
export function inlineImageDisplayName(url: string, mimeType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").filter(Boolean).pop();
    if (base) return sanitizeAttachmentName(decodeURIComponent(base));
  } catch {
    // fall through to the generic name below
  }
  const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
  return `inline-image.${ext}`;
}
