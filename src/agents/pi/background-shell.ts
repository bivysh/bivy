// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

/** Tracks process groups left behind by a completed shell tool call. In a
 * non-interactive POSIX shell, `command &` remains in the detached shell's
 * process group after the shell exits, which gives us an observable lifecycle
 * without trying to infer state from the assistant's prose. */
export class BackgroundShellTracker {
  private readonly groups = new Set<number>();
  private readonly listeners = new Set<(count: number) => void>();
  private timer?: NodeJS.Timeout;

  get count(): number { return this.groups.size; }

  subscribe(listener: (count: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  track(groupId: number): void {
    if (!groupId || !processGroupAlive(groupId) || this.groups.has(groupId)) return;
    this.groups.add(groupId);
    this.emit();
    this.timer ??= setInterval(() => this.sweep(), 1_000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.groups.clear();
  }

  private sweep(): void {
    let changed = false;
    for (const id of this.groups) {
      if (!processGroupAlive(id)) {
        this.groups.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
    if (this.groups.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.groups.size);
  }
}

export function processGroupAlive(groupId: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wrap pi's normal shell backend. The tiny, output-free prefix records the
 * detached shell's process-group id; after the foreground shell returns, a
 * still-live group means it deliberately left background work behind. */
export function createBackgroundAwareBashOperations(
  tracker: BackgroundShellTracker,
  base: BashOperations = createLocalBashOperations(),
): BashOperations {
  return {
    async exec(command, cwd, options) {
      if (process.platform === "win32") return base.exec(command, cwd, options);
      const marker = path.join(os.tmpdir(), `bivy-bg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const quotedMarker = `'${marker.replace(/'/g, `'\\''`)}'`;
      try {
        const result = await base.exec(`printf '%s' "$$" > ${quotedMarker}\n${command}`, cwd, options);
        const groupId = Number.parseInt(await fs.promises.readFile(marker, "utf8").catch(() => ""), 10);
        if (Number.isSafeInteger(groupId) && groupId > 0) tracker.track(groupId);
        return result;
      } finally {
        void fs.promises.unlink(marker).catch(() => {});
      }
    },
  };
}
