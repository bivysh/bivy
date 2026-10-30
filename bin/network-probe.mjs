// SPDX-License-Identifier: MIT
// Connectivity probes for `bivy doctor --network`: run from this machine,
// independent of the node's own link state, so they say which hop fails.
import net from "node:net";
import tls from "node:tls";

/** GET `url` and report the HTTP status and round trip. Never throws. */
export async function probeHttp(url, timeoutMs = 5000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: describe(error, timeoutMs) };
  }
}

/**
 * Open a TCP connection to a ws(s):// or http(s):// URL's host, with a TLS
 * handshake for wss/https, and close it. Covers DNS, firewall and certificate
 * failures without needing credentials for the service behind it.
 */
export function probeConnect(url, timeoutMs = 5000) {
  const started = Date.now();
  let target;
  try { target = new URL(url); } catch { return Promise.resolve({ ok: false, ms: 0, error: "invalid URL" }); }
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const options = { host, port, ...(secure ? { servername: net.isIP(host) ? undefined : host } : {}) };
    const socket = secure ? tls.connect(options) : net.connect(options);
    const done = (result) => { clearTimeout(timer); socket.destroy(); resolve({ ...result, ms: Date.now() - started }); };
    const timer = setTimeout(() => done({ ok: false, error: `timed out after ${timeoutMs / 1000}s` }), timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => done({ ok: true }));
    socket.once("error", (error) => done({ ok: false, error: describe(error, timeoutMs) }));
  });
}

function describe(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `timed out after ${timeoutMs / 1000}s`;
  const cause = error?.cause ?? error;
  const code = cause?.code ? `${cause.code}: ` : "";
  return `${code}${cause?.message || String(error)}`.slice(0, 200);
}
