// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeInfo } from "@bivy/core";

/** Resolve the short `bivy run <agent>` name to its governed runtime and report
 * whether an unpinned terminal session can be discovered for chat takeover. */
export function runtimeSupportsTerminalTakeover(agent: string | undefined, runtimes: RuntimeInfo[]): boolean {
  const alias = String(agent || "");
  const runtime = runtimes.find((candidate) =>
    candidate.id === alias || candidate.id === `${alias}-approvals` || candidate.id === `${alias}-code-sdk`,
  );
  const caps = runtime?.capabilities as { sessionDiscovery?: boolean } | undefined;
  return Boolean(caps?.sessionDiscovery);
}
