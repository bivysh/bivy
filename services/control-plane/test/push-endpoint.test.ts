// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { isPushServiceEndpoint } from "../src/push-endpoint.js";

/**
 * The control plane POSTs to a Web Push subscription's endpoint, which the
 * caller supplies. Only the browsers' push services may be targets; pin the
 * URL shapes that must not slip through a host-suffix check.
 */

const accepted = [
  "https://fcm.googleapis.com/fcm/send/abc",
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://web.push.apple.com/QAbc",
  "https://wns2-par02p.notify.windows.com/w/?token=abc",
];
const refused = [
  "http://fcm.googleapis.com/fcm/send/abc", // not https
  "https://fcm.googleapis.com:8443/fcm/send/abc", // explicit port
  "https://user:pw@fcm.googleapis.com/fcm/send/abc", // userinfo
  "https://fcm.googleapis.com.example.com/x", // suffix spoof
  "https://evilfcm.googleapis.com/x", // not a label boundary
  "https://127.0.0.1/x",
  "https://localhost/x",
  "not a url",
  42,
];

for (const url of accepted) assert.equal(isPushServiceEndpoint(url), true, `accepts ${url}`);
for (const url of refused) assert.equal(isPushServiceEndpoint(url), false, `refuses ${String(url)}`);
console.log(`✓ push endpoints: ${accepted.length} accepted, ${refused.length} refused`);
