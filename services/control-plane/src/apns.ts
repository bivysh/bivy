// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

/** Deployment-configured APNs transport. Never accepts a host, topic, key or
 * environment from clients. Alerts intentionally contain no session content. */
export function createApns(env: NodeJS.ProcessEnv = process.env, connectTo: typeof connect = connect) {
  if (env.APNS_ENABLED !== "1") return undefined;
  const { APNS_TEAM_ID: team, APNS_KEY_ID: keyId, APNS_TOPIC: topic, APNS_PRIVATE_KEY: pem, APNS_ENVIRONMENT: environment } = env;
  if (!team || !/^[A-Z0-9]{10}$/.test(team) || !keyId || !/^[A-Z0-9]{10}$/.test(keyId) || !topic || !/^[A-Za-z0-9.-]{3,255}$/.test(topic) || !pem || !["sandbox", "production"].includes(environment || "")) throw new Error("Incomplete APNs configuration");
  const publicUrl = new URL(env.PUBLIC_CONTROL_PLANE_URL || "");
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("APNs requires an HTTPS control-plane origin");
  const origin = publicUrl.origin;
  const key = createPrivateKey(pem.includes("-----BEGIN") ? pem : Buffer.from(pem, "base64").toString("utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs requires a P-256 key");
  const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  let cached = "", issued = 0, active = 0;
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    if (cached && now - issued < 3000) return cached;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: team, iat: now })}`;
    cached = `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    issued = now;
    return cached;
  }
  return {
    async send(token: string, payload: Record<string, unknown>): Promise<number> {
      if (!/^[a-f0-9]{64,200}$/.test(token)) throw new Error("Invalid APNs token");
      if (active >= 32) throw new Error("APNs capacity exceeded");
      active++;
      try {
        return await new Promise<number>((resolve, reject) => {
          const session = connectTo(host);
          const finish = (error?: Error, status = 0) => {
            clearTimeout(timer);
            session.destroy();
            if (error) reject(error); else resolve(status);
          };
          const timer = setTimeout(() => finish(new Error("APNs timeout")), 10_000);
          session.on("error", () => finish(new Error("APNs transport failed")));
          const request = session.request({
            ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${jwt()}`,
            "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "0",
            "apns-collapse-id": createHash("sha256").update(`${origin}:${String(payload.kind || "")}:${String(payload.url || "")}`).digest("hex"),
          });
          let status = 0;
          request.on("response", headers => { status = Number(headers[":status"]); });
          request.on("data", () => {}); // Never log tokens or Apple's response bodies.
          request.on("error", () => finish(new Error("APNs request failed")));
          request.on("end", () => finish(undefined, status));
          request.end(JSON.stringify({ ...nativePushPayload(payload), origin }));
        });
      } finally { active--; }
    },
  };
}

export function nativePushPayload(payload: Record<string, unknown>) {
  // An opaque session URL is only a hint; opening it still requires account
  // authorization. Do not put prompts, titles, tool output or tokens on APNs.
  const path = typeof payload.url === "string" ? payload.url : "";
  const url = path.length <= 1024 && /^\/(?:sessions|runs)\/[A-Za-z0-9_-]+(?:\?node=[A-Za-z0-9_-]+)?$/.test(path) ? path : undefined;
  return { aps: { alert: { title: "Session update", body: "Open the app to view your session." }, sound: "default" }, ...(url ? { url } : {}) };
}
