// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

const MIGRATED = [
  "components/ApprovalCard.tsx",
  "components/QuestionCard.tsx",
  "components/TurnAttentionCard.tsx",
  "components/ArtifactsSheet.tsx",
  "components/ToolGroup.tsx",
  "components/SessionList.tsx",
  "components/RunDetails.tsx",
  "components/ChangesCard.tsx",
  "components/RunPill.tsx",
] as const;
const LEGACY = ["approval-badge", "question-chip", "artifact-badge", "tool-fail", "chk"] as const;

test("semantic labels use the canonical Badge", async () => {
  for (const path of MIGRATED) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<Badge");
    for (const legacy of LEGACY) expect(source, path).not.toContain(legacy);
  }
  const github = await readFile(new URL("components/GithubPill.tsx", ROOT), "utf8");
  expect(github).toContain('className="badge github-pill"');
});

test("settings status labels use canonical badges", async () => {
  for (const path of [
    "components/Rulesets.tsx",
    "components/NodeSwitcher.tsx",
    "components/CredentialVault.tsx",
    "components/Settings.tsx",
    "components/VoiceSettings.tsx",
    "components/MachineCapabilities.tsx",
  ]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<Badge");
    expect(source, path).not.toMatch(/className=(?:"chip(?:\s|")|{`chip(?:\s|\$|`))/);
  }
});

test("legacy generic chips have been removed", async () => {
  for (const path of [
    "components/Rulesets.tsx",
    "components/NodeSwitcher.tsx",
    "components/CredentialVault.tsx",
    "components/Settings.tsx",
    "components/VoiceSettings.tsx",
    "components/MachineCapabilities.tsx",
    "components/QueueRouting.tsx",
    "components/Ephemeral.tsx",
    "components/ChangesCard.tsx",
    "components/GithubQueue.tsx",
    "components/HostedMachines.tsx",
    "components/RunDetails.tsx",
    "components/RunPill.tsx",
  ]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).not.toMatch(/className=(?:"chip(?:\s|")|{`chip(?:\s|\$|`))/);
  }
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).not.toContain(".chip");
});

test("canonical badge shell exposes tones and variants", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".badge {");
  for (const tone of ["accent", "ok", "warn", "danger", "merged", "unseen"]) {
    expect(css).toContain(`.badge[data-tone="${tone}"]`);
  }
  for (const legacy of LEGACY) expect(css).not.toContain(`.${legacy}`);
  const filterRule = css.slice(css.indexOf(".session-filter-count {"), css.indexOf("}", css.indexOf(".session-filter-count {")));
  expect(filterRule).not.toMatch(/(?:background|border-radius|color|font-size|font-weight)\s*:/);
});
