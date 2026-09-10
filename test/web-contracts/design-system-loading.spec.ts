// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

const LOADING_SURFACES = [
  "App.tsx",
  "components/ChatView.tsx",
  "components/Composer.tsx",
  "components/ConnectRunner.tsx",
  "components/NodeSwitcher.tsx",
  "components/VoiceRecorder.tsx",
] as const;

const LEGACY_SPINNERS = [
  "chat-loading-spinner",
  "attach-spinner",
  "reconnect-spinner",
  "voice-spinner",
  "onboarding-spinner",
] as const;

test("indeterminate loading surfaces use the canonical Spinner", async () => {
  for (const path of LOADING_SURFACES) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<Spinner");
    for (const legacy of LEGACY_SPINNERS) expect(source, path).not.toContain(legacy);
  }
});

test("legacy spinner recipes have been removed", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".spinner {");
  for (const legacy of LEGACY_SPINNERS) expect(css).not.toContain(`.${legacy}`);
});
