#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Compatibility facade; the Pi CLI integration lives under src/agents/pi.
await import("./agents/pi/cli.js");
