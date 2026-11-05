// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Which Web Push subscription endpoints the control plane will deliver to.
// A subscription's endpoint is caller-supplied and the server POSTs to it on
// every notification, so it must be a browser vendor's push service, never an
// arbitrary (or internal) URL.

/** Push services the major browsers hand out, as host suffixes. One row per vendor. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com", // Chrome, Android, Opera, Samsung Internet, Brave
  "android.googleapis.com", // older Chrome subscriptions (GCM endpoint)
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari (macOS, iOS home-screen apps)
  "notify.windows.com", // Edge (WNS)
];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** True when `endpoint` is an https URL on a known push service (default port). */
export function isPushServiceEndpoint(endpoint: unknown, hosts: readonly string[] = PUSH_SERVICE_HOSTS): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((suffix) => hostMatches(host, suffix));
}
