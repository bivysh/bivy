// SPDX-License-Identifier: AGPL-3.0-only
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export type WorkResult = { id: string; claimToken?: string; action: "complete" | "fail" | "needs-attention" };

/** Metadata only. Persist before delivery so restarting the daemon retries the
 * acknowledgement, not the agent. Scope files to the enrolled control plane. */
export class WorkResultOutbox {
  private readonly pending = new Map<string, WorkResult>();
  private readonly file?: string;
  constructor(directory?: string, scope = "") {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
    if (existsSync(this.file)) {
      const rows: WorkResult[] = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !['complete','fail','needs-attention'].includes(row.action))) throw new Error('Invalid work result outbox; refusing to replay work');
      for (const row of rows) this.pending.set(row.id, row);
    }
  }
  list(): WorkResult[] { return [...this.pending.values()]; }
  has(id: string): boolean { return this.pending.has(id); }
  put(result: WorkResult): void { this.pending.set(result.id, result); this.flush(); }
  remove(id: string): void { this.pending.delete(id); this.flush(); }
  private flush(): void {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.list())); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temp, this.file); }
    catch (error) { if (existsSync(temp)) unlinkSync(temp); throw error; }
    const dir = openSync(path.dirname(this.file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
