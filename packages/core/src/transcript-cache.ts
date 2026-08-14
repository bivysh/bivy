// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Persistent transcript cache (IndexedDB). Mirrors the legacy
// public/app/transcript-cache.js: decrypted transcripts are stored per session
// so past chats paint instantly — even before the node connects — and reconnects
// backfill only the new tail (history cursor: count + a node-issued hash) instead
// of re-streaming the whole conversation. Plaintext at rest, consistent with the
// room key already living in localStorage.
//
// Degrades to a no-op when IndexedDB is unavailable (private mode, SSR, tests
// without a fake), so callers never need to feature-detect.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PromptAttachment } from "./protocol.js";

/** [message text, attachments sent with that message] — see
 *  SessionStore.attachmentsForHistory/restoreAttachments in store.ts. Stored
 *  as tuples (not a Map) so it round-trips through IndexedDB structured
 *  clone and JSON the same way on every engine. */
export type CachedAttachmentEntry = [string, PromptAttachment[]];

export interface CachedTranscript {
  sessionId: string;
  messages: any[];
  count: number;
  historyHash: string;
  updatedAt?: number;
  /** Real attachment bytes for this session's user messages, persisted
   *  alongside history so they survive a reload/backgrounding instead of
   *  degrading to the node's plain-text placeholder (e.g. "[Image
   *  attachment: foo.png (12 KB)]") the next time this session is opened. */
  attachments?: CachedAttachmentEntry[];
}

export interface TranscriptCache {
  get(sessionId: string): Promise<CachedTranscript | null>;
  put(
    sessionId: string,
    messages: any[],
    count: number,
    historyHash: string,
    attachments?: CachedAttachmentEntry[],
  ): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface TranscriptCacheOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
  maxSessions?: number;
}

const STORE = "t";

export function createTranscriptCache(opts: TranscriptCacheOptions = {}): TranscriptCache {
  const idbFactory =
    opts.indexedDB ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined) ?? (globalThis as any).indexedDB;
  const dbName = opts.dbName || "bivy-transcripts";
  const maxSessions = opts.maxSessions || 50;
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function db(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        if (!idbFactory) return resolve(null);
        req = idbFactory.open(dbName, 1);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE, { keyPath: "sessionId" });
        } catch {
          /* already exists */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  }

  function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
    return db().then(
      (database) =>
        new Promise<T | null>((resolve) => {
          if (!database) return resolve(null);
          let out: T | null = null;
          let tx: IDBTransaction;
          try {
            tx = database.transaction(STORE, mode);
          } catch {
            return resolve(null);
          }
          const r = fn(tx.objectStore(STORE));
          if (r) r.onsuccess = () => (out = (r as IDBRequest<T>).result);
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        }),
    );
  }

  async function get(sessionId: string): Promise<CachedTranscript | null> {
    if (!sessionId) return null;
    return (await run<CachedTranscript>("readonly", (s) => s.get(sessionId))) || null;
  }

  async function put(
    sessionId: string,
    messages: any[],
    count: number,
    historyHash: string,
    attachments?: CachedAttachmentEntry[],
  ): Promise<void> {
    // The cursor is sourced from this cache, so an entry is always a complete
    // prefix [0, count) for its hash — never store a partial without the hash.
    if (!sessionId || !historyHash) return;
    await run("readwrite", (s) =>
      s.put({
        sessionId,
        messages,
        count,
        historyHash,
        updatedAt: Date.now(),
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
    );
    const all = await run<CachedTranscript[]>("readonly", (s) => s.getAll() as IDBRequest<CachedTranscript[]>);
    if (Array.isArray(all) && all.length > maxSessions) {
      const stale = all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(maxSessions);
      await run("readwrite", (s) => {
        for (const e of stale) s.delete(e.sessionId);
      });
    }
  }

  async function remove(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await run("readwrite", (s) => s.delete(sessionId));
  }

  return { get, put, delete: remove };
}
