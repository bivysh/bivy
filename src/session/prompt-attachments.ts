// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import type { PromptImage } from "./record.js";
import type { AttachmentRef, AttachmentStore } from "./attachment-store.js";

// Attachment payloads cross the wire, so validate fields before using them.
type PromptAttachment =
  | { kind: "image"; name?: unknown; size?: unknown; mimeType?: unknown; data?: unknown }
  | { kind: "file"; name?: unknown; size?: unknown; mimeType?: unknown; data?: unknown; text?: unknown; truncated?: unknown; omitted?: unknown };

function safeAttachmentName(value: unknown) {
  return String(value || "attachment").replace(/[\r\n]/g, " ").slice(0, 180);
}

/** A decoded attachment ready to be written into a session's workdir. */
export interface DecodedAttachment {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  size: number;
  bytes?: Buffer;
  text?: string;
  truncated?: boolean;
}

/**
 * Split composer attachments into channels:
 *   - `images`     — base64 blobs passed to the model as vision.
 *   - `imageNotes` — short image labels for naming a new session.
 *   - `files`      — all decoded attachments (including images) to be written to
 *                    disk by materializeAttachments so the agent can open them
 *                    with its normal file tools. Any file type is supported;
 *                    binary files arrive as base64 `data`.
 */
const MAX_PROMPT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_ATTACHMENTS_BYTES = 40 * 1024 * 1024;

export function attachmentsFrom(value: unknown): { images: PromptImage[]; imageNotes: string[]; files: DecodedAttachment[] } {
  if (!Array.isArray(value)) return { images: [], imageNotes: [], files: [] };
  const images: PromptImage[] = [];
  const imageNotes: string[] = [];
  const files: DecodedAttachment[] = [];
  let totalBytes = 0;
  if (value.length > 12) throw new Error("A message can include at most 12 attachments");
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const attachment = raw as PromptAttachment;
    const name = safeAttachmentName(attachment.name);
    const size = Number(attachment.size || 0);
    const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType ? attachment.mimeType : undefined;
    const encodedBytes = typeof attachment.data === "string" ? Math.floor(attachment.data.length * 3 / 4) : 0;
    const textBytes = attachment.kind === "file" && typeof attachment.text === "string" ? Buffer.byteLength(attachment.text) : 0;
    const actualBytes = encodedBytes || textBytes;
    if (actualBytes > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`${name} exceeds the 10 MiB attachment limit`);
    totalBytes += actualBytes;
    if (totalBytes > MAX_PROMPT_ATTACHMENTS_BYTES) throw new Error("Attachments exceed the 40 MiB per-message limit");
    if (attachment.kind === "image" && typeof attachment.data === "string") {
      const imgMime = mimeType ?? "image/png";
      images.push({ type: "image", data: attachment.data, mimeType: imgMime });
      imageNotes.push(`[Image attachment: ${name}${size ? ` (${size} bytes)` : ""}]`);
      files.push({ kind: "image", name, mimeType: imgMime, size, bytes: Buffer.from(attachment.data, "base64") });
    } else if (attachment.kind === "file") {
      if (typeof attachment.data === "string" && attachment.data) {
        files.push({ kind: "file", name, mimeType: mimeType ?? "application/octet-stream", size, bytes: Buffer.from(attachment.data, "base64"), truncated: !!attachment.truncated });
      } else if (typeof attachment.text === "string" && attachment.text) {
        files.push({ kind: "file", name, mimeType: mimeType ?? "text/plain", size, text: attachment.text, truncated: !!attachment.truncated });
      }
      // A file with neither bytes nor text (e.g. omitted/unreadable) carries
      // nothing to write, so there is nothing to hand the agent — skip it.
    }
  }
  return { images, imageNotes, files };
}

/** Strip a user-supplied filename to a safe basename — no path traversal, no
 * characters that would break the placeholder note or the filesystem. */
export function sanitizeAttachmentFilename(name: string): string {
  const base = path
    .basename(String(name || ""))
    .replace(/[/\\\r\n\t[\]]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return base || "attachment";
}

/**
 * Write decoded attachments into `<workdir>/.bivy-attachments/` and return
 * one prose note per file (carrying the absolute path) to append to the prompt.
 * This is what makes an uploaded file of ANY type — binary included — readable
 * by the agent's file tools. Filenames are sanitized and de-duplicated so two
 * `report.pdf`s don't clobber. Best-effort: a failure degrades to a note rather
 * than throwing, so a bad attachment never sinks the whole turn.
 */
export function materializeAttachments(workdir: string, files: DecodedAttachment[], attachmentStore: AttachmentStore): { note: string; refs: AttachmentRef[] } {
  if (!files.length) return { note: "", refs: [] };
  const refs: AttachmentRef[] = [];
  // Store every file durably in the global content-addressed store first (for
  // re-findability), independent of the per-workdir copy below. Best-effort per
  // file so one bad blob doesn't lose the others.
  for (const file of files) {
    const bytes = file.bytes ?? (typeof file.text === "string" ? Buffer.from(file.text, "utf8") : undefined);
    if (!bytes) continue;
    try {
      refs.push(attachmentStore.put(bytes, { name: sanitizeAttachmentFilename(file.name), mimeType: file.mimeType, kind: file.kind }));
    } catch (error) {
      console.warn("[attachments] failed to store file:", error instanceof Error ? error.message : String(error));
    }
  }
  const dir = path.join(workdir, ".bivy-attachments");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { note: files.map((f) => `[${f.kind === "image" ? "Image" : "File"} attachment: ${sanitizeAttachmentFilename(f.name)} could not be saved: ${why}]`).join("\n"), refs };
  }
  const notes: string[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const safeBase = sanitizeAttachmentFilename(file.name);
    const ext = path.extname(safeBase);
    const stem = safeBase.slice(0, safeBase.length - ext.length) || safeBase;
    let safe = safeBase;
    let n = 1;
    while (used.has(safe) || fs.existsSync(path.join(dir, safe))) {
      safe = `${stem}-${n}${ext}`;
      n += 1;
    }
    used.add(safe);
    const dest = path.join(dir, safe);
    const label = `${safe} (${file.size ? `${file.size} bytes, ` : ""}${file.mimeType}${file.truncated ? ", truncated" : ""})`;
    try {
      if (file.bytes) fs.writeFileSync(dest, file.bytes);
      else if (typeof file.text === "string") fs.writeFileSync(dest, file.text, "utf8");
      else continue;
      notes.push(`[${file.kind === "image" ? "Image" : "File"} attachment: ${label} saved to ${dest} - read it with your file tools]`);
    } catch (error) {
      notes.push(`[${file.kind === "image" ? "Image" : "File"} attachment: ${label} could not be saved: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return { note: notes.join("\n"), refs };
}

