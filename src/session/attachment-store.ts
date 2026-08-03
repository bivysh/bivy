// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Content-addressed blob store for message attachments (images + files).
//
// Attachments used to be fragile and un-refindable: image bytes were passed to
// the model as vision for a single turn and then dropped entirely (never written
// anywhere), while file attachments were written only into the session's
// ephemeral worktree at `<workdir>/.bivy-attachments/`. Nothing survived in a
// stable, session-independent location, so a reload on another device — or after
// the client's in-memory attachment cache aged out — showed only a bare
// "[Image attachment: …]" placeholder.
//
// This store fixes that: every attachment is written ONCE to a global folder
// under `<appDir>/attachments/`, addressed by the SHA-256 of its bytes. Identical
// bytes dedupe for free (same hash → same path), the location is stable and
// re-findable, and the transcript references a blob by hash instead of carrying
// (or losing) the bytes. Paths are two-level sharded (`ab/cd/<hash>`) so a busy
// node never piles millions of entries into one directory. A small sidecar
// `<hash>.json` remembers a human name / mime / size for the blob.
//
// Out of scope for now (tracked as TODOs): garbage-collecting blobs no transcript
// references any more, and a global size cap / LRU eviction on the store.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A durable reference to a stored attachment — what the transcript records. */
export interface AttachmentRef {
  /** SHA-256 of the blob's bytes, lowercase hex. The content address. */
  hash: string;
  /** Original (sanitized) filename, for display and downloads. */
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

/** The sidecar metadata persisted alongside a blob. */
export interface AttachmentMeta extends AttachmentRef {
  /** Epoch millis of the first time these bytes were stored. */
  createdAt: number;
}

/** A 64-char lowercase-hex SHA-256, the only shape a valid hash can take. */
const HASH_RE = /^[0-9a-f]{64}$/;

/** Whether `value` is a well-formed content hash (guards path building). */
export function isValidAttachmentHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

/**
 * A global, content-addressed attachment store rooted at a single directory.
 * All methods are best-effort and synchronous, matching the surrounding
 * server code (EventLog, SidecarStore) — attachment persistence must never sink
 * a turn, so a write failure surfaces as a thrown error the caller degrades to a
 * text note rather than a crash.
 */
export interface AttachmentStoreOptions {
  /** Reject a single blob above this size before touching disk. */
  maxFileBytes?: number;
  /** Soft global cap enforced by reference-aware gc(). */
  maxStoreBytes?: number;
  /** Unreferenced blobs younger than this survive ordinary retention GC. */
  retentionMs?: number;
}

export interface AttachmentStoreStats {
  blobs: number;
  bytes: number;
  removedBlobs?: number;
  removedBytes?: number;
  overCapBytes?: number;
}

export class AttachmentStore {
  private readonly maxFileBytes: number;
  private readonly maxStoreBytes: number;
  private readonly retentionMs: number;

  constructor(private dir: string, options: AttachmentStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 25 * 1024 * 1024;
    this.maxStoreBytes = options.maxStoreBytes ?? 2 * 1024 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  /** `<dir>/ab/cd` for a hash beginning `abcd…`. */
  private shardDir(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2, 4));
  }

  private blobPath(hash: string): string {
    return path.join(this.shardDir(hash), hash);
  }

  private metaPath(hash: string): string {
    return path.join(this.shardDir(hash), `${hash}.json`);
  }

  /**
   * Store `bytes` and return a durable reference. Content-addressed, so calling
   * this twice with identical bytes writes the blob once and returns the same
   * hash. The blob write is skipped when the file already exists (dedupe); the
   * sidecar is written only the first time so the earliest name/mime wins.
   */
  put(bytes: Buffer, opts: { name: string; mimeType: string; kind: "image" | "file" }): AttachmentRef {
    if (bytes.length > this.maxFileBytes) throw new Error(`Attachment exceeds the ${this.maxFileBytes}-byte node limit`);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const ref: AttachmentRef = { hash, name: opts.name, mimeType: opts.mimeType, size: bytes.length, kind: opts.kind };
    fs.mkdirSync(this.shardDir(hash), { recursive: true });
    const blob = this.blobPath(hash);
    if (!fs.existsSync(blob)) {
      const usage = this.stats();
      if (usage.bytes + bytes.length > this.maxStoreBytes) {
        throw new Error(`Attachment store would exceed its ${this.maxStoreBytes}-byte capacity`);
      }
      this.atomicWrite(blob, bytes);
    }
    if (!fs.existsSync(this.metaPath(hash))) {
      const meta: AttachmentMeta = { ...ref, createdAt: Date.now() };
      try {
        this.atomicWrite(this.metaPath(hash), Buffer.from(JSON.stringify(meta)));
      } catch {
        // A missing sidecar only costs us the remembered name/mime — the blob is
        // what matters, so never let a sidecar write failure fail the store.
      }
    }
    return ref;
  }

  private atomicWrite(destination: string, bytes: Buffer): void {
    const tmp = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, bytes, { flag: "wx" });
      fs.renameSync(tmp, destination);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* rename succeeded or cleanup best effort */ }
    }
  }

  private blobEntries(): Array<{ hash: string; path: string; size: number; mtimeMs: number }> {
    if (!fs.existsSync(this.dir)) return [];
    const entries: Array<{ hash: string; path: string; size: number; mtimeMs: number }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && isValidAttachmentHash(entry.name)) {
          try {
            const stat = fs.statSync(full);
            entries.push({ hash: entry.name, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch { /* raced deletion */ }
        } else if (entry.isFile() && entry.name.includes(".tmp-")) {
          // Repair an interrupted atomic write after a conservative grace period.
          try {
            const stat = fs.statSync(full);
            if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(full);
          } catch { /* best effort */ }
        }
      }
    };
    walk(this.dir);
    return entries;
  }

  stats(): AttachmentStoreStats {
    const entries = this.blobEntries();
    return { blobs: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
  }

  /** Delete only unreferenced blobs. Retention removes old orphans first; when
   * over the global cap, oldest remaining orphans are removed until under cap.
   * Referenced history is never sacrificed to satisfy the soft cap. */
  gc(referenced: ReadonlySet<string>, now = Date.now()): AttachmentStoreStats {
    const entries = this.blobEntries().sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let removedBlobs = 0;
    let removedBytes = 0;
    const remove = (entry: (typeof entries)[number]) => {
      try {
        fs.unlinkSync(entry.path);
        try { fs.unlinkSync(this.metaPath(entry.hash)); } catch { /* sidecar optional */ }
        bytes -= entry.size;
        removedBlobs += 1;
        removedBytes += entry.size;
      } catch { /* best-effort sweep */ }
    };
    for (const entry of entries) {
      if (!referenced.has(entry.hash) && now - entry.mtimeMs >= this.retentionMs) remove(entry);
    }
    if (bytes > this.maxStoreBytes) {
      for (const entry of entries) {
        if (bytes <= this.maxStoreBytes) break;
        if (!referenced.has(entry.hash) && fs.existsSync(entry.path)) remove(entry);
      }
    }
    return { blobs: entries.length - removedBlobs, bytes, removedBlobs, removedBytes, overCapBytes: Math.max(0, bytes - this.maxStoreBytes) };
  }

  /** The blob's metadata, or null if the hash is unknown/malformed. */
  readMeta(hash: string): AttachmentMeta | null {
    if (!isValidAttachmentHash(hash)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(hash), "utf8")) as AttachmentMeta;
    } catch {
      return null;
    }
  }

  /** The on-disk path of a stored blob, or null if absent/malformed. */
  getPath(hash: string): string | null {
    if (!isValidAttachmentHash(hash)) return null;
    const blob = this.blobPath(hash);
    return fs.existsSync(blob) ? blob : null;
  }

  /** Read a stored blob's raw bytes, or null if absent/malformed. */
  read(hash: string): Buffer | null {
    const p = this.getPath(hash);
    if (!p) return null;
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }
}
