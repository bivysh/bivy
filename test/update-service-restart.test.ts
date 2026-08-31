// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { detectInstallKind } from "../bin/install-kind.mjs";
import { hasConfiguredService } from "../bin/service-state.mjs";

const exists = (paths: string[] = []) => (candidate: string) => paths.includes(candidate);

test("scoped npm installs use the npm-global update path", () => {
  const root = path.join(path.sep, "usr", "lib", "node_modules", "@bivy", "bivy");
  assert.equal(detectInstallKind(root, exists()), "npm-global");
});

test("scoped npx installs remain ephemeral", () => {
  const root = path.join(path.sep, "home", "user", ".npm", "_npx", "123", "node_modules", "@bivy", "bivy");
  assert.equal(detectInstallKind(root, exists()), "npx");
});

test("an installed service is restarted even when the config hint is false", () => {
  const unit = path.join(path.sep, "home", "user", ".config", "systemd", "user", "bivy.service");
  assert.equal(hasConfiguredService({ service: false }, unit, exists([unit])), true);
  assert.equal(hasConfiguredService({}, unit, exists([unit])), true);
  assert.equal(hasConfiguredService({ service: false }, unit, exists()), false);
});
