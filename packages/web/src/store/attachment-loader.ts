// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
export interface AttachmentBytes { mimeType: string; data: string }
const CACHE = "bivy-attachments-v1";
const MAX_BYTES = 64 * 1024 * 1024;

/** Plaintext local cache, like the transcript cache. Content hashes are immutable.
 * Cache Storage is optional (private mode/quota errors must not break loading).
 * Writes are serialized so concurrent completions cannot race the size bound. */
export class AttachmentDiskCache {
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private key(scope: string, hash: string): string {
    return new URL(`/__attachment_cache__/${encodeURIComponent(scope)}/${encodeURIComponent(hash)}`, location.origin).href;
  }
  async get(scope: string, hash: string): Promise<AttachmentBytes | null> {
    try {
      if (this.closed) return null;
      const response = await (await caches.open(CACHE)).match(this.key(scope, hash));
      if (!response) return null;
      const value = await response.json();
      return typeof value.data === "string" && typeof value.mimeType === "string" ? value : null;
    } catch { return null; }
  }
  put(scope: string, hash: string, value: AttachmentBytes): void {
    if (this.closed) return;
    this.writes = this.writes.then(async () => {
      const body = JSON.stringify(value);
      const size = new Blob([body]).size;
      if (size > MAX_BYTES) return;
      const cache = await caches.open(CACHE);
      const key = this.key(scope, hash);
      await cache.delete(key);
      let total = size;
      const entries = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const bytes = Number(response?.headers.get("Content-Length")) || 0;
        total += bytes;
        entries.push({ request, bytes });
      }
      for (const entry of entries) {
        if (total <= MAX_BYTES) break;
        await cache.delete(entry.request);
        total -= entry.bytes;
      }
      await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Content-Length": String(size) } }));
    }).catch(() => { /* unavailable or quota exceeded */ });
  }
  async clear(): Promise<void> {
    this.closed = true;
    await this.writes;
    try { await caches.delete(CACHE); } catch { /* unavailable */ }
  }
}

interface Job {
  key: string;
  priority: number;
  sequence: number;
  load: () => Promise<AttachmentBytes | null>;
  resolve: (value: AttachmentBytes | null) => void;
}

/** Batch mounts before sending, then load newest first with only two transfers
 * in flight. Deduplicate chat/sheet/gallery requests and bound retained bytes. */
export class AttachmentLoader {
  private pending = new Map<string, Promise<AttachmentBytes | null>>();
  private memory = new Map<string, AttachmentBytes>();
  private bytes = 0;
  private queue: Job[] = [];
  private active = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  fetch(key: string, priority: number, load: Job["load"]): Promise<AttachmentBytes | null> {
    const cached = this.memory.get(key);
    if (cached) {
      this.memory.delete(key);
      this.memory.set(key, cached);
      return Promise.resolve(cached);
    }
    const existing = this.pending.get(key);
    if (existing) {
      const job = this.queue.find((j) => j.key === key);
      if (job) job.priority = Math.max(job.priority, priority);
      return existing;
    }
    const result = new Promise<AttachmentBytes | null>((resolve) => {
      this.queue.push({ key, priority, sequence: this.sequence++, load, resolve });
    });
    this.pending.set(key, result);
    this.schedule();
    return result;
  }
  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 0);
  }
  private drain(): void {
    this.queue.sort((a, b) => b.priority - a.priority || b.sequence - a.sequence);
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.run(job);
    }
  }
  private async run(job: Job): Promise<void> {
    let value: AttachmentBytes | null = null;
    try { value = await job.load(); } catch { /* allow a later retry */ }
    if (value) {
      // JS strings can require two bytes per character.
      const size = value.data.length * 2;
      if (size <= MAX_BYTES) {
        while (this.bytes + size > MAX_BYTES && this.memory.size) {
          const key = this.memory.keys().next().value!;
          this.bytes -= this.memory.get(key)!.data.length * 2;
          this.memory.delete(key);
        }
        this.memory.set(job.key, value);
        this.bytes += size;
      }
    }
    this.pending.delete(job.key);
    this.active--;
    job.resolve(value);
    this.schedule();
  }
}
