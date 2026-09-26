// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { InputEvent } from "./rfb.js";

/** What an agent can do in a desktop app, in its screenshot's pixels. */
export type AppAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "middle" | "right"; count?: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; steps?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string };

/** VNC button-mask bits: buttons, then the wheel's four directions. */
const BUTTONS = { left: 1, middle: 2, right: 4 } as const;
const WHEEL = { up: 8, down: 16, left: 32, right: 64 } as const;
/** X keysyms by name. Super is ⌘ on a Mac. */
const MODIFIERS: Record<string, number> = {
  shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3, alt: 0xffe9, option: 0xffe9, opt: 0xffe9,
  cmd: 0xffeb, command: 0xffeb, super: 0xffeb, meta: 0xffeb, win: 0xffeb,
};
const KEYS: Record<string, number> = {
  enter: 0xff0d, return: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b, backspace: 0xff08, delete: 0xffff, insert: 0xff63,
  home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  space: 0x20, plus: 0x2b, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0xffbe + i])),
};
/** Characters typed as keys rather than as text. */
const TYPED: Record<string, number> = { "\n": KEYS.enter!, "\t": KEYS.tab! };
const PAUSE = 30;

const keysym = (char: string) => { const cp = char.codePointAt(0)!; return cp <= 0xff ? cp : 0x0100_0000 + cp; };
const press = (sym: number): InputEvent[] => [{ key: { keysym: sym, down: true } }, { key: { keysym: sym, down: false } }];

/** "cmd+shift+s", "ctrl+c", "enter": modifiers held around one key. */
function combo(keys: string): InputEvent[] {
  const parts = keys.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.pop()!;
  const held = parts.map((part) => {
    const sym = MODIFIERS[part];
    if (sym === undefined) throw new Error(`Unknown modifier "${part}". Use ${[...new Set(Object.keys(MODIFIERS))].join(", ")}.`);
    return sym;
  });
  // A letter with Shift is its capital, as a keyboard sends it.
  const char = [...key].length === 1 ? (held.includes(MODIFIERS.shift!) ? key.toUpperCase() : key) : undefined;
  const sym = KEYS[key] ?? MODIFIERS[key] ?? (char && keysym(char));
  if (!sym) throw new Error(`Unknown key "${key}". Use a character or ${Object.keys(KEYS).join(", ")}.`);
  return [...held.map((s) => ({ key: { keysym: s, down: true } })), ...press(sym), ...held.reverse().map((s) => ({ key: { keysym: s, down: false } }))];
}

const point = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 65536;

/** Checks an action from the command line or API. */
export function readAction(input: unknown): AppAction {
  const a = (input ?? {}) as Record<string, unknown>;
  const at = (...keys: string[]) => { if (!keys.every((k) => point(a[k]))) throw new Error("Coordinates must be whole pixels in the app's screenshot."); };
  switch (a.kind) {
    case "click":
      at("x", "y");
      if (a.button !== undefined && !(typeof a.button === "string" && a.button in BUTTONS)) throw new Error("Button must be left, middle or right.");
      if (a.count !== undefined && ![1, 2, 3].includes(a.count as number)) throw new Error("Click count must be 1, 2 or 3.");
      return a as AppAction;
    case "move": at("x", "y"); return a as AppAction;
    case "drag": at("x", "y", "toX", "toY"); return a as AppAction;
    case "scroll":
      at("x", "y");
      if (!(typeof a.direction === "string" && a.direction in WHEEL)) throw new Error("Scroll direction must be up, down, left or right.");
      if (a.steps !== undefined && !(Number.isInteger(a.steps) && (a.steps as number) >= 1 && (a.steps as number) <= 50)) throw new Error("Scroll steps must be 1–50.");
      return a as AppAction;
    case "type":
      if (typeof a.text !== "string" || !a.text || a.text.length > 2000) throw new Error("Text must be 1–2000 characters.");
      return a as AppAction;
    case "key":
      if (typeof a.keys !== "string" || !a.keys.trim() || a.keys.length > 100) throw new Error("Keys must name a key, like enter or cmd+s.");
      combo(a.keys);
      return a as AppAction;
    default: throw new Error("Action must be click, move, drag, scroll, type or key.");
  }
}

/** The pointer and key events that perform an action. */
export function inputEvents(action: AppAction): InputEvent[] {
  const at = (x: number, y: number, buttons = 0): InputEvent => ({ pointer: { x, y, buttons } });
  switch (action.kind) {
    case "move": return [at(action.x, action.y)];
    case "click": {
      const button = BUTTONS[action.button ?? "left"];
      return [at(action.x, action.y), ...Array.from({ length: action.count ?? 1 }, () => [at(action.x, action.y, button), at(action.x, action.y)]).flat()];
    }
    case "drag": {
      // Through a few points on the way, so apps see a drag, not a jump.
      const path = Array.from({ length: 8 }, (_, i) => at(Math.round(action.x + (action.toX - action.x) * (i + 1) / 8), Math.round(action.y + (action.toY - action.y) * (i + 1) / 8), 1));
      return [at(action.x, action.y), at(action.x, action.y, 1), ...path.flatMap((step) => [{ wait: PAUSE }, step]), at(action.toX, action.toY)];
    }
    case "scroll": {
      const bit = WHEEL[action.direction];
      return [at(action.x, action.y), ...Array.from({ length: action.steps ?? 3 }, () => [at(action.x, action.y, bit), at(action.x, action.y)]).flat()];
    }
    case "type": return [...action.text].flatMap((char) => [...press(TYPED[char] ?? keysym(char)), { wait: 5 }]);
    case "key": return combo(action.keys);
  }
}
