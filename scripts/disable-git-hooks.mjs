#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// One-shot cleanup: undo the old local pre-push CI gate. Earlier versions set
// `core.hooksPath=.githooks` (via the former scripts/setup-hooks.mjs) so a git
// pre-push hook ran the full CI suite locally. We now rely on GitHub Actions
// (.github/workflows/ci.yml) for that, so this unsets the stale config on any
// clone that still has it — invoked automatically by the `prepare` npm script.
//
// Kept deliberately dependency-free and fail-soft: a checkout without git, or a
// bare-environment `npm ci`, must never break because of this.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Nothing to do if this isn't a git working tree (e.g. installed as a dep or an
// exported tarball).
if (!existsSync(join(ROOT, '.git'))) {
  process.exit(0);
}

try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (current === '.githooks') {
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: ROOT, stdio: 'ignore' });
    console.log('✔  removed the legacy local pre-push hook (core.hooksPath). CI runs on GitHub now.');
  }
} catch {
  // No hooksPath set, git missing, or config failed — nothing to clean up.
  process.exit(0);
}
