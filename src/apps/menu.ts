// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import net from "node:net";

/** One entry of a desktop app's menu bar, as its display reports it. */
export type MenuItem = { separator: true } | { title: string; enabled: boolean; shortcut?: string; checked?: boolean; items?: MenuItem[] };
export interface AppMenu { title: string; items: MenuItem[] }

const MAX_ITEMS = 3000;
const MAX_DEPTH = 4;
const TIMEOUT_MS = 5_000;

/** A path of titles, top menu first: "File > Export…" or ["File", "Export…"]. */
export function readMenuPath(input: unknown): string[] {
  const path = typeof input === "string" ? input.split(">").map((part) => part.trim()) : input;
  if (!Array.isArray(path) || !path.length || path.length > 8 || path.some((part) => typeof part !== "string" || !part || part.length > 200)) {
    throw new Error("A menu item is a path of titles, like \"File > Save\".");
  }
  return path as string[];
}

/** Keeps what the display says to known fields and bounded sizes: the menu
 * comes from the app, so it is data to show, never markup. */
function clean(items: unknown, depth: number, budget: { left: number }): MenuItem[] {
  if (!Array.isArray(items)) return [];
  const out: MenuItem[] = [];
  for (const raw of items) {
    if (budget.left-- <= 0) break;
    const item = raw as Record<string, unknown>;
    if (item?.separator === true) { out.push({ separator: true }); continue; }
    if (typeof item?.title !== "string" || !item.title) continue;
    const entry: MenuItem = { title: item.title.slice(0, 200), enabled: item.enabled === true };
    if (typeof item.shortcut === "string" && item.shortcut.length <= 20) entry.shortcut = item.shortcut;
    if (item.checked === true) entry.checked = true;
    const children = depth < MAX_DEPTH ? clean(item.items, depth + 1, budget) : [];
    if (children.length) entry.items = children;
    out.push(entry);
  }
  return out;
}

/** One request to a display's control socket, one JSON answer. */
function ask(control: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(control);
    let data = "";
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("The app didn't answer in time.")));
    socket.on("data", (chunk) => { data += chunk; if (data.length > 4 * 1024 * 1024) socket.destroy(new Error("The app's menu is too large.")); });
    socket.on("error", (error: NodeJS.ErrnoException) => reject(error.code ? new Error("The app isn't running.") : error));
    socket.on("end", () => {
      try {
        const answer = JSON.parse(data) as Record<string, unknown>;
        if (typeof answer.error === "string") reject(new Error(answer.error.slice(0, 300))); else resolve(answer);
      } catch { reject(new Error("The app's display gave an unreadable answer.")); }
    });
    socket.end(`${JSON.stringify(request)}\n`);
  });
}

/** The app's menu bar, read now, so enabled and checked states are current. */
export async function readMenus(control: string): Promise<AppMenu[]> {
  const answer = await ask(control, { menu: true });
  const budget = { left: MAX_ITEMS };
  return (Array.isArray(answer.menus) ? answer.menus : []).flatMap((menu: Record<string, unknown>) =>
    typeof menu?.title === "string" && menu.title ? [{ title: menu.title.slice(0, 200), items: clean(menu.items, 1, budget) }] : []);
}

/** Chooses the menu item at `path`, as if picked from the menu bar. */
export async function pressMenu(control: string, path: string[]): Promise<void> {
  await ask(control, { press: path });
}
