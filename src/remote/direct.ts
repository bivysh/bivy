// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Direct access over Tailscale: no control plane, no relay. `bivy tailscale`
// writes `<data-dir>/tailscale.json` and points `tailscale serve` (HTTPS on the
// machine's ts.net name, tailnet only) at a loopback port; the node opens that
// port as its direct listener. Every connection on it is treated as remote, so
// callers need a device token, which a phone gets by redeeming a pairing code.
import fs from "node:fs";
import path from "node:path";

export const DIRECT_CONFIG_FILE = "tailscale.json";

export interface DirectListenerConfig {
  /** Loopback port `tailscale serve` forwards to. */
  port: number;
  /** The machine's tailnet name, e.g. `box.tail1234.ts.net`, for links. */
  hostname?: string;
}

export function loadDirectListenerConfig(appDir: string): DirectListenerConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDir, DIRECT_CONFIG_FILE), "utf8")) as Partial<DirectListenerConfig>;
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { port, hostname: typeof raw.hostname === "string" && raw.hostname ? raw.hostname : undefined };
  } catch {
    return null;
  }
}
