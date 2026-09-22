// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestHandler } from "express";

/** Optional operator allowlist for packaged clients. CORS is not authentication:
 * every protected route retains its existing bearer/ticket checks. */
export function packagedClientCors(value = process.env.PACKAGED_CLIENT_ORIGINS || ""): RequestHandler {
  const origins = new Set(value.split(",").map(s => s.trim()).filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["https:", "capacitor:", "ionic:"].includes(url.protocol) || !url.hostname || url.hostname.includes("*") || url.username || url.password ||
        (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash ||
        origin !== `${url.protocol}//${url.host}`) {
      throw new Error("PACKAGED_CLIENT_ORIGINS must contain exact HTTPS or native origins, without wildcards, paths, or credentials");
    }
  }
  const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  const headers = new Set(["authorization", "content-type"]);
  return (req, res, next) => {
    if (!origins.size) return next();
    res.vary("Origin");
    const origin = req.get("origin");
    if (!origin || !origins.has(origin)) return next();
    if (req.method === "OPTIONS") {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
      const requestedMethod = req.get("access-control-request-method") || "";
      const requestedHeaders = (req.get("access-control-request-headers") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!methods.has(requestedMethod) || requestedHeaders.some(h => !headers.has(h))) {
        res.status(403).end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", [...methods].join(", "));
      res.setHeader("Access-Control-Allow-Headers", [...headers].join(", "));
      res.status(204).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    next();
  };
}
