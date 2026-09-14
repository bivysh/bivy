// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteSessionAdmission, RemoteSessionAdmissionError } from "../src/session/remote-session-admission.js";

test("only new remote sessions are admitted: local, resume, and internal probes are free", async () => {
  const keys: string[] = [];
  const admission = createRemoteSessionAdmission(async key => { keys.push(key); return { allowed: true }; });
  await admission.admit();
  await admission.run("manual", async () => {
    await admission.admit({ resume: true });
    await admission.admit({ internal: true });
    await admission.admit();
  });
  await admission.run("automation", async () => {
    await admission.admit({ resume: true }); // Follow-up on an existing session.
    await admission.admit(); // Missing-session fallback really creates a new one.
  });
  assert.deepEqual(keys, ['["manual",0]', '["automation",0]']);
});

test("multiple creations count separately; concurrent requests and delivery retries keep stable keys", async () => {
  const keys: string[] = [];
  const admission = createRemoteSessionAdmission(async key => { keys.push(key); return { allowed: true }; });
  const work = async () => { await Promise.resolve(); await admission.admit(); await admission.admit(); };
  await Promise.all([admission.run("a", work), admission.run("b", work)]);
  await admission.run("a", work);
  assert.deepEqual(keys.filter(key => key.startsWith('["a"')), ['["a",0]', '["a",1]', '["a",0]', '["a",1]']);
  assert.deepEqual(keys.filter(key => key.startsWith('["b"')), ['["b",0]', '["b",1]']);
});

test("quota denial prevents creation but cannot block local use or resumes", async () => {
  const admission = createRemoteSessionAdmission(async () => ({ allowed: false, code: "quota_exhausted", reason: "Try again next week" }));
  let created = false;
  await assert.rejects(admission.run("run", async () => {
    await admission.admit();
    created = true;
  }), (error: unknown) => error instanceof RemoteSessionAdmissionError && error.code === "quota_exhausted" && error.message === "Try again next week");
  assert.equal(created, false);
  await admission.admit();
  await admission.run("resume", () => admission.admit({ resume: true }));
});

test("transport and malformed decisions fail closed; unconfigured self-hosted allow is honored", async () => {
  for (const authorize of [async () => { throw new Error("network"); }, async () => ({} as { allowed: boolean })]) {
    const admission = createRemoteSessionAdmission(authorize);
    await assert.rejects(admission.run("request", () => admission.admit()), RemoteSessionAdmissionError);
  }
  const selfHosted = createRemoteSessionAdmission(async () => ({ allowed: true }));
  await selfHosted.run("request", () => selfHosted.admit());
});
