// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { BlockList, isIP } from "node:net";

// The address a connection is counted against for the per-IP cap. Behind a
// reverse proxy (Caddy, kamal-proxy) every socket comes from the proxy, so the
// cap would be shared by all users. RELAY_TRUST_PROXY names the proxies whose
// X-Forwarded-For is believed, the same shape as the control plane's
// TRUST_PROXY: IPs, CIDRs, or the named subnets below. Unset trusts nobody, so a
// directly exposed relay can't be talked into a different address.

const NAMED_SUBNETS: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

export type TrustedProxies = (address: string) => boolean;

function family(address: string): "ipv4" | "ipv6" | null {
  const version = isIP(address);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}

function normalize(address: string): string {
  return address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/** Parse RELAY_TRUST_PROXY; throws on anything that isn't an IP, CIDR or named subnet. */
export function parseTrustedProxies(setting?: string): TrustedProxies {
  const entries = (setting ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) return () => false;
  const list = new BlockList();
  for (const entry of entries.flatMap((value) => NAMED_SUBNETS[value.toLowerCase()] ?? [value])) {
    const [address, prefix] = entry.split("/");
    const kind = family(address ?? "");
    const bits = prefix === undefined ? (kind === "ipv4" ? 32 : 128) : Number(prefix);
    if (!kind || !/^\d+$/.test(String(bits)) || bits > (kind === "ipv4" ? 32 : 128)) {
      throw new Error(`RELAY_TRUST_PROXY: "${entry}" is not an IP, CIDR, or one of ${Object.keys(NAMED_SUBNETS).join(", ")}`);
    }
    list.addSubnet(address!, bits, kind);
  }
  return (address) => {
    const kind = family(address);
    return kind !== null && list.check(address, kind);
  };
}

/**
 * The client's address: the socket peer, or, when that peer is a trusted proxy,
 * the nearest X-Forwarded-For hop that isn't one. Walking from the right means
 * a client can prepend whatever it likes without being believed.
 */
export function clientAddress(remoteAddress: string | null | undefined, forwardedFor: string | string[] | undefined, trusted: TrustedProxies): string {
  let address = normalize(remoteAddress ?? "") || "unknown";
  if (!trusted(address)) return address;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "").split(",").map(normalize).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i]!;
    if (!family(hop)) return address;
    address = hop;
    if (!trusted(hop)) return hop;
  }
  return address;
}
