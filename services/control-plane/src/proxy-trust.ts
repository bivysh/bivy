// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { Application } from "express";

/** Trust only operator-selected proxy addresses, never an arbitrary hop count. */
export function configureProxyTrust(app: Application, trustedProxies?: string): void {
  const addresses = trustedProxies?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
  // Some IP parsers accept bare numbers as abbreviated IPv4 addresses; reject
  // those explicitly so an operator cannot mistake this for a hop-count option.
  if (addresses.some(address => /^(?:true|false|\d+)$/i.test(address))) {
    throw new Error("TRUST_PROXY must list proxy IPs/CIDRs or named subnets, not booleans or hop counts.");
  }
  // Express validates the IPs/CIDRs (and its named subnets) when setting this.
  // An empty setting leaves direct clients unable to spoof X-Forwarded-For.
  app.set("trust proxy", addresses.length ? addresses : false);
}
