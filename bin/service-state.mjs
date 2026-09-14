// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";

/**
 * Whether an install has a background service that an update must restart.
 * The on-disk unit/plist is authoritative; cli.json.service is only a hint and
 * may be absent on migrated installs.
 */
export function hasConfiguredService(config, serviceFile, existsSync = fs.existsSync) {
  return Boolean(config?.service) || existsSync(serviceFile);
}
