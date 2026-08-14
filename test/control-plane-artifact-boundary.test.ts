// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Attachments/artifacts (bytes, filenames, captions, the `artifact` marking)
// are end-to-end encrypted between a node and its paired devices and must
// never reach the control plane in plaintext (see docs/security-model.md,
// "What the control plane sees"). This is a static guard: it fails loudly if
// a future change wires the node's attachment machinery into
// services/control-plane, rather than relying on that boundary being noticed
// only in review.
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlPlaneSrc = path.join(repoRoot, "services", "control-plane", "src");

// Symbols/paths that are specific to the node-local, content-addressed
// attachment store and the client-side Artifacts projection — none of these
// have any legitimate reason to appear in control-plane source.
const FORBIDDEN = [
  "attachment-store",
  "AttachmentStore",
  "attach-to-chat",
  "PromptAttachment",
  "artifacts.js",
  "artifacts.ts",
  "deriveArtifacts",
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

test("services/control-plane never imports or references the node attachment/artifact machinery", () => {
  const files = listTsFiles(controlPlaneSrc);
  assert.ok(files.length > 10, "sanity check: expected to find the control-plane source tree");
  const offenders: string[] = [];
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    for (const needle of FORBIDDEN) {
      if (body.includes(needle)) offenders.push(`${path.relative(repoRoot, file)}: contains "${needle}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the control-plane WorkItem output shape stays limited to bounded evidence links, not filenames/bytes", () => {
  // The one legitimate "artifact" concept on the control plane: a run's
  // reported output.artifactUrl (see runEvidence.ts's artifactRef on the
  // client) — an external link, never a filename, caption, or byte payload.
  // Guard the field name itself doesn't silently grow a sibling that would
  // carry more than a link.
  const storeTs = fs.readFileSync(path.join(controlPlaneSrc, "store.ts"), "utf8");
  const artifactFieldMatches = [...storeTs.matchAll(/artifact\w*\s*[?:]/gi)].map((m) => m[0]);
  for (const field of artifactFieldMatches) {
    assert.match(field.toLowerCase(), /^artifacturl/, `unexpected artifact-like field on control-plane store types: ${field}`);
  }
});
