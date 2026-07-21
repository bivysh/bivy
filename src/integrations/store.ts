// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import type { IntegrationConnection } from "./types.js";

// Tiny persistent store for integration connections. Secrets (API keys, OAuth
// tokens) live here, so the file is written 0600 and kept out of any agent's
// config/session directory that ships with sessions.
export class IntegrationStore {
  private readonly file: string;
  private cache = new Map<string, IntegrationConnection>();

  constructor(appDir: string) {
    this.file = path.join(appDir, "integrations.json");
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, IntegrationConnection>;
      for (const [id, conn] of Object.entries(raw)) this.cache.set(id, conn);
    } catch {
      // Missing or unreadable: start empty.
    }
  }

  private persist() {
    const obj: Record<string, IntegrationConnection> = {};
    for (const [id, conn] of this.cache) obj[id] = conn;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
  }

  get(id: string): IntegrationConnection | undefined {
    return this.cache.get(id);
  }

  list(): IntegrationConnection[] {
    return [...this.cache.values()];
  }

  set(conn: IntegrationConnection) {
    this.cache.set(conn.id, conn);
    this.persist();
  }

  remove(id: string): boolean {
    const had = this.cache.delete(id);
    if (had) this.persist();
    return had;
  }
}
