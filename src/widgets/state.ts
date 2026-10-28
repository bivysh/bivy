// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// What chat widgets saved, per session: `bivy.setState(…)` in a widget lands
// here, the app reads it back when the widget is shown again (on any device),
// and `bivy widget state` shows it to the agent.
//
// One small JSON file per session under <appDir>/widget-state. A widget's key is
// chosen by the app (see packages/web/src/widgets/key.ts); this store only
// bounds what it is given, because a widget is agent-written code.
import fs from "node:fs";
import path from "node:path";

/** One widget's saved state, serialized. Enough for a form or a checklist. */
export const MAX_WIDGET_STATE_BYTES = 64 * 1024;
/** Widgets per session that may keep state. The oldest is dropped past this. */
export const MAX_WIDGETS_PER_SESSION = 100;

const SESSION_ID = /^[\w.-]{1,128}$/;
const WIDGET_KEY = /^[\w.:-]{1,128}$/;

export interface WidgetStateEntry {
  state: unknown;
  updatedAt: number;
}

export class WidgetStateStore {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id.");
    return path.join(this.dir, `${sessionId}.json`);
  }

  all(sessionId: string): Record<string, WidgetStateEntry> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(sessionId), "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, WidgetStateEntry>) : {};
    } catch (error) {
      if ((error as Error).message === "Invalid session id.") throw error;
      return {};
    }
  }

  set(sessionId: string, key: string, state: unknown, now = Date.now()): WidgetStateEntry {
    if (!WIDGET_KEY.test(key)) throw new Error("Invalid widget key.");
    const serialized = JSON.stringify(state ?? null);
    if (Buffer.byteLength(serialized, "utf8") > MAX_WIDGET_STATE_BYTES) {
      throw new Error(`A widget can save up to ${MAX_WIDGET_STATE_BYTES / 1024} KB.`);
    }
    const entries = this.all(sessionId);
    const entry = { state: JSON.parse(serialized) as unknown, updatedAt: now };
    entries[key] = entry;
    const keys = Object.keys(entries);
    if (keys.length > MAX_WIDGETS_PER_SESSION) {
      keys.sort((a, b) => (entries[a]!.updatedAt ?? 0) - (entries[b]!.updatedAt ?? 0));
      for (const old of keys.slice(0, keys.length - MAX_WIDGETS_PER_SESSION)) delete entries[old];
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(sessionId);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(entries)}\n`);
    fs.renameSync(temp, file);
    return entry;
  }
}
