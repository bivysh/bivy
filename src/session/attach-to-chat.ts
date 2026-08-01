// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Plan an AGENT-sent chat attachment: the reverse of the composer paperclip.
// An agent points at a file it produced in the workspace (a rendered chart, a
// screenshot, a report), and Bivy surfaces it into the chat as an image/file
// chip. This module is the PURE, testable half — path confinement, size cap, and
// mime/kind classification — returning bytes + metadata (or a human-readable
// error). The server half stores the bytes in the content-addressed
// AttachmentStore, emits the live `attachment` event, and persists the outbound
// reference for durable history.
//
// Security posture: the resolved file MUST live inside the session's working
// directory. An agent is a semi-trusted process; without confinement, a prompt
// injection could turn "attach a file to the chat" into "exfiltrate /etc/passwd
// (or ~/.ssh/id_rsa) to the user's phone". Symlinks are resolved before the
// check so a symlink inside the workspace can't point out of it.

import fs from "node:fs";
import path from "node:path";

/** Ceiling for a single agent attachment. Kept comfortably under the relay's
 *  32 MiB reassembly limit (see packages/core/src/wire-format.ts) so a large
 *  attachment still travels to a phone over the encrypted relay in chunks. */
export const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface AttachPlan {
  bytes: Buffer;
  /** Sanitized display filename. */
  name: string;
  mimeType: string;
  kind: "image" | "file";
}

export interface AttachPlanError {
  error: string;
}

export function isAttachPlanError(value: AttachPlan | AttachPlanError): value is AttachPlanError {
  return typeof (value as AttachPlanError).error === "string";
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
};

/** Sniff a mime type from the leading magic bytes for the common image/PDF
 *  formats, so a mislabeled or extension-less file still classifies correctly.
 *  Returns "" when nothing matches (caller falls back to extension/default). */
export function sniffMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}

/** Strip directory components and control/path characters from a filename so it
 *  is safe to show and to store as an attachment display name. */
export function sanitizeAttachmentName(name: string): string {
  const base = path.basename(String(name || "").trim());
  const cleaned = base
    .replace(/[/\\]+/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, "")
    .trim();
  return cleaned.slice(0, 200) || "attachment";
}

/**
 * Resolve, confine, size-check, read, and classify a file the agent asked to
 * attach. `filePath` may be absolute or relative to `workspaceDir`; either way
 * the resolved real path must sit inside `workspaceDir`.
 */
export function planAttachment(opts: {
  workspaceDir: string;
  filePath: string;
  mimeType?: string;
  name?: string;
  maxBytes?: number;
}): AttachPlan | AttachPlanError {
  const raw = String(opts.filePath || "").trim();
  if (!raw) return { error: "No file path given." };

  const workspaceDir = path.resolve(opts.workspaceDir);
  const resolved = path.resolve(workspaceDir, raw);

  // Confinement, symlink-safe: resolve the real path of the file before comparing
  // against the real workspace root. realpathSync also fails cleanly for a missing
  // file.
  let realFile: string;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceDir);
  } catch {
    return { error: "Workspace directory is unavailable." };
  }
  try {
    realFile = fs.realpathSync(resolved);
  } catch {
    return { error: `File not found: ${raw}` };
  }
  const rel = path.relative(realRoot, realFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: "Refusing to attach a file outside the session workspace." };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    return { error: `File not found: ${raw}` };
  }
  if (stat.isDirectory()) return { error: `Not a file: ${raw}` };

  const maxBytes = opts.maxBytes ?? MAX_AGENT_ATTACHMENT_BYTES;
  if (stat.size > maxBytes) {
    return { error: `File is too large to attach (${stat.size} bytes; limit ${maxBytes}).` };
  }
  if (stat.size === 0) return { error: "Refusing to attach an empty file." };

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(realFile);
  } catch {
    return { error: `Could not read file: ${raw}` };
  }

  const ext = path.extname(realFile).toLowerCase();
  const mimeType =
    (opts.mimeType && String(opts.mimeType).trim()) ||
    sniffMime(bytes) ||
    EXT_MIME[ext] ||
    "application/octet-stream";
  const kind: "image" | "file" = mimeType.startsWith("image/") ? "image" : "file";
  const name = sanitizeAttachmentName(opts.name || path.basename(realFile));

  return { bytes, name, mimeType, kind };
}
