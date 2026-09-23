// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createServer, connect } from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import { createApns, nativePushPayload } from "../src/apns.js";
import { associatedApps } from "../src/associated-apps.js";
assert.equal(createApns({}), undefined);
assert.throws(() => createApns({ APNS_ENABLED: "1" }), /configuration/);
assert.equal(associatedApps(), undefined);
assert.throws(() => associatedApps("*.example"), /Invalid/);
const association = associatedApps("ABCDEFGHIJ.sh.example.app,ABCDEFGHIJ.sh.example.app")!;
assert.equal(association.applinks.details[0].appIDs.length, 1);
assert.deepEqual(association.applinks.details[0].components.map(c => c["/"]), ["/sessions/*", "/runs/*"]);
const payload = nativePushPayload({ title: "secret title", body: "secret prompt", token: "secret token", sessionId: "private", url: "/sessions/id?node=node_1" });
assert.equal(payload.url, "/sessions/id?node=node_1");
assert.ok(!JSON.stringify(payload).includes("secret"));
for (const url of ["https://evil.example", "//evil.example/path", "/auth/device/start", "/sessions/a?token=secret", "/sessions/" + "a".repeat(5000)]) {
  assert.equal(nativePushPayload({ url }).url, undefined);
}
assert.equal(nativePushPayload({ url: "/runs/run_1" }).url, "/runs/run_1");
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const server = createServer();
let status = 200;
const requests: { headers: Record<string, unknown>; body: string }[] = [];
server.on('stream', (stream, headers) => {
  let body = '';
  stream.on('data', chunk => { body += chunk; });
  stream.on('end', () => {
    requests.push({ headers, body });
    stream.respond({ ':status': status }); stream.end('{}');
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sender = createApns({ APNS_ENABLED: '1', APNS_TEAM_ID: 'ABCDEFGHIJ', APNS_KEY_ID: 'KLMNOPQRST', APNS_TOPIC: 'sh.example.app', APNS_ENVIRONMENT: 'sandbox', APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, ((host: string) => {
    assert.equal(host, 'https://api.sandbox.push.apple.com');
    return connect(`http://127.0.0.1:${address.port}`);
  }) as typeof connect)!;
  assert.equal(await sender.send('a'.repeat(64), { url: '/sessions/a', title: 'secret' }), 200);
  status = 410;
  assert.equal(await sender.send('a'.repeat(64), {}), 410);
  assert.equal(requests[0].headers['apns-topic'], 'sh.example.app');
  assert.equal(requests[0].headers['apns-push-type'], 'alert');
  assert.ok(!requests[0].body.includes('secret'));
  const jwt = String(requests[0].headers.authorization).slice('bearer '.length);
  const [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'ABCDEFGHIJ');
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  assert.equal(requests[1].headers.authorization, requests[0].headers.authorization, 'provider JWT is cached');
  await assert.rejects(sender.send('not-a-token', {}), /Invalid/);
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("APNs configuration, ES256 authentication, HTTP/2 delivery, association scope and minimized payload checks passed");
