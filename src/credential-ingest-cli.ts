// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Small setup-time entry point: normalize a native agent login into Bivy's
// encrypted model credential vault without passing credential material on argv.
import { ingestAgentCredentials } from "./runtime/credential-ingest.js";

const [agentId, credsDir, piDir] = process.argv.slice(2);
if (!agentId || !credsDir || !piDir) process.exit(2);

try {
  const imported = await ingestAgentCredentials(agentId, credsDir, piDir);
  process.exit(imported > 0 ? 0 : 3);
} catch (error) {
  if (process.env.BIVY_DEBUG) console.error(error);
  process.exit(1);
}
