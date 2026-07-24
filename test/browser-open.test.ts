// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { canOpenBrowser, openBrowser } from "../src/browser-open.js";

/**
 * Regression coverage for #70: GitHub OAuth sign-in during `bivy setup`
 * unconditionally tried to spawn a browser opener, even on a headless Linux
 * server with no display and no `xdg-open`. That spawn was already made safe
 * against crashing (#67), but it still ran a doomed process and claimed to be
 * "opening" a browser that never appeared. canOpenBrowser()/openBrowser()
 * detect the headless case up front so callers can skip the spawn entirely
 * and print accurate copy instead.
 */

let failures = 0;
const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("canOpenBrowser: always true on macOS, regardless of display env", () => {
  withPlatform("darwin", () => {
    assert.equal(canOpenBrowser({}), true);
  });
});

test("canOpenBrowser: always true on Windows, regardless of display env", () => {
  withPlatform("win32", () => {
    assert.equal(canOpenBrowser({}), true);
  });
});

test("canOpenBrowser: false on Linux with no DISPLAY/WAYLAND_DISPLAY (headless server)", () => {
  withPlatform("linux", () => {
    assert.equal(canOpenBrowser({}), false);
  });
});

test("canOpenBrowser: false on Linux with a display but no xdg-open on PATH", () => {
  withPlatform("linux", () => {
    // An empty PATH guarantees `command -v xdg-open` fails regardless of what's
    // actually installed on the machine running this test.
    assert.equal(canOpenBrowser({ DISPLAY: ":0", PATH: "" }), false);
  });
});

test("openBrowser: no-ops and returns false when the machine can't open a browser", () => {
  withPlatform("linux", () => {
    // openBrowser() checks canOpenBrowser() (reading the real process.env)
    // before ever touching child_process.spawn, so clearing DISPLAY/
    // WAYLAND_DISPLAY for the duration of the call is enough to prove it
    // never attempts to open anything on a headless box.
    const hadDisplay = "DISPLAY" in process.env;
    const hadWayland = "WAYLAND_DISPLAY" in process.env;
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      assert.equal(openBrowser("https://example.com/authorize"), false);
    } finally {
      if (hadDisplay) process.env.DISPLAY = display; else delete process.env.DISPLAY;
      if (hadWayland) process.env.WAYLAND_DISPLAY = wayland; else delete process.env.WAYLAND_DISPLAY;
    }
  });
});

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nbrowser-open: all tests passed");
