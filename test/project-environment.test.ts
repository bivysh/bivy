// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findProjectEnvironment,
  loadProjectEnvironment,
  parseProjectEnvironment,
  PROJECT_ENVIRONMENT_PATH,
  STARTER_PROJECT_ENVIRONMENT,
  validateProjectEnvironment,
} from "../src/project-environment.js";

test("a minimal valid manifest parses with defaults", () => {
  const result = parseProjectEnvironment(`
version: 1
capabilities:
  required: [docker]
  preferred: [gpu]
`);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.environment?.capabilities, { required: ["docker"], preferred: ["gpu"] });
});

test("the starter manifest is itself valid", () => {
  const result = parseProjectEnvironment(STARTER_PROJECT_ENVIRONMENT);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("rejects unknown top-level and nested keys, and a non-1 version", () => {
  const result = validateProjectEnvironment({ version: 2, mystery: true, capabilities: { required: [], extra: 1 } });
  assert.equal(result.ok, false);
  const errors = result.errors.join("\n");
  assert.match(errors, /version must be 1/);
  assert.match(errors, /environment\.mystery/);
  assert.match(errors, /capabilities\.extra/);
});

test("rejects malformed capability tags without throwing", () => {
  const result = validateProjectEnvironment({ version: 1, capabilities: { required: ["GPU", "has space", 42] } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /capabilities\.required/);
});

test("caps required/preferred tag counts", () => {
  const many = Array.from({ length: 33 }, (_, i) => `tag-${i}`);
  const result = validateProjectEnvironment({ version: 1, capabilities: { required: many } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /at most 32/);
});

test("services reference a package-script name, not raw shell", () => {
  const ok = validateProjectEnvironment({
    version: 1,
    services: { postgres: { healthCheck: { script: "db:health", timeoutMinutes: 2 }, start: { script: "db:start" } } },
  });
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.equal(ok.environment?.services?.postgres.healthCheck?.script, "db:health");

  const shell = validateProjectEnvironment({
    version: 1,
    services: { postgres: { start: { script: "docker compose up -d; rm -rf /" } } },
  });
  assert.equal(shell.ok, false);
  assert.match(shell.errors.join("\n"), /services\.postgres\.start\.script/);
});

test("rejects an unknown service name shape and caps the service count", () => {
  const badName = validateProjectEnvironment({ version: 1, services: { "Not Valid": { start: { script: "x" } } } });
  assert.equal(badName.ok, false);
  assert.match(badName.errors.join("\n"), /services\.Not Valid/);

  const tooMany: Record<string, unknown> = {};
  for (let i = 0; i < 11; i++) tooMany[`svc-${i}`] = { start: { script: "x" } };
  const capped = validateProjectEnvironment({ version: 1, services: tooMany });
  assert.equal(capped.ok, false);
  assert.match(capped.errors.join("\n"), /at most 10/);
});

test("timeoutMinutes on a service step is bounded", () => {
  const result = validateProjectEnvironment({
    version: 1,
    services: { db: { start: { script: "db:start", timeoutMinutes: 90 } } },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /timeoutMinutes must be an integer from 1 to 30/);
});

test("loading never executes anything — parsing is pure even with a service script declared", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-environment-"));
  try {
    const bivyDir = path.join(dir, ".bivy");
    fs.mkdirSync(bivyDir, { recursive: true });
    fs.writeFileSync(
      path.join(bivyDir, "environment.yaml"),
      "version: 1\nservices:\n  db:\n    start:\n      script: definitely-not-a-real-script\n",
    );
    // Loading a manifest whose script does not exist as a real, runnable
    // command must still succeed — the loader only parses/validates text.
    const found = findProjectEnvironment(dir);
    assert.equal(found, path.join(dir, PROJECT_ENVIRONMENT_PATH));
    const env = loadProjectEnvironment(dir);
    assert.equal(env?.services?.db.start?.script, "definitely-not-a-real-script");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("loadProjectEnvironment throws with the aggregated errors for an invalid file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-environment-"));
  try {
    fs.mkdirSync(path.join(dir, ".bivy"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".bivy", "environment.yaml"), "version: 2\n");
    assert.throws(() => loadProjectEnvironment(dir), /version must be 1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("findProjectEnvironment walks up from a nested working directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-environment-"));
  try {
    fs.mkdirSync(path.join(dir, ".bivy"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".bivy", "environment.yaml"), STARTER_PROJECT_ENVIRONMENT);
    const nested = path.join(dir, "packages", "web", "src");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findProjectEnvironment(nested), path.join(dir, ".bivy", "environment.yaml"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
