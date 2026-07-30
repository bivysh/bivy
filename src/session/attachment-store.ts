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
export class AttachmentStore {
  constructor(private dir: string) {}

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
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const ref: AttachmentRef = { hash, name: opts.name, mimeType: opts.mimeType, size: bytes.length, kind: opts.kind };
    fs.mkdirSync(this.shardDir(hash), { recursive: true });
    const blob = this.blobPath(hash);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, bytes);
    if (!fs.existsSync(this.metaPath(hash))) {
      const meta: AttachmentMeta = { ...ref, createdAt: Date.now() };
      try {
        fs.writeFileSync(this.metaPath(hash), JSON.stringify(meta));
      } catch {
        // A missing sidecar only costs us the remembered name/mime — the blob is
        // what matters, so never let a sidecar write failure fail the store.
      }
    }
    return ref;
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
