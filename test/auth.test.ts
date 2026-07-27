// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { isMultiUserHost, resolveAuth, isAuthorized } from "../src/auth.js";
import type { NodeIdentity } from "../src/identity.js";

const SINGLE_USER_PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
  "bin:x:2:2:bin:/bin:/usr/sbin/nologin",
  "sync:x:4:65534:sync:/bin:/bin/sync",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "systemd-network:x:998:998::/run/systemd:/usr/sbin/nologin",
  "petter:x:1000:1000:Petter,,,:/home/petter:/bin/bash",
  "",
].join("\n");

const MULTI_USER_PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
  "alice:x:1000:1000:Alice:/home/alice:/bin/bash",
  "bob:x:1001:1001:Bob:/home/bob:/bin/zsh",
  "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin",
  "",
].join("\n");

const SINGLE_USER_DSCL = ["_spotlight 89", "_www 70", "nobody 4294967294", "root 0", "petter 501", ""].join("\n");

const MULTI_USER_DSCL = ["_spotlight 89", "root 0", "alice 501", "bob 502", ""].join("\n");

function fakeReq(remoteAddress: string | undefined, extraHeaders: Record<string, string> = {}): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: extraHeaders,
    url: "/api/status",
  } as unknown as IncomingMessage;
}

function fakeIdentity(verifiedDeviceId: string | null = null): NodeIdentity {
  return { verifyToken: () => verifiedDeviceId } as unknown as NodeIdentity;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function run() {
  // --- isMultiUserHost: Linux /etc/passwd detection --------------------------
  assert.equal(
    isMultiUserHost({ platform: "linux", passwdText: SINGLE_USER_PASSWD }),
    false,
    "one human account + system accounts → single-user",
  );
  assert.equal(
    isMultiUserHost({ platform: "linux", passwdText: MULTI_USER_PASSWD }),
    true,
    "two human accounts → multi-user",
  );
  assert.equal(
    isMultiUserHost({ platform: "linux", passwdText: "" }),
    false,
    "empty passwd → single-user (conservative)",
  );
  assert.equal(
    isMultiUserHost({ platform: "linux", passwdText: "not:a:valid:line" }),
    false,
    "malformed passwd lines are skipped, not counted",
  );

  // --- isMultiUserHost: macOS dscl detection ----------------------------------
  assert.equal(
    isMultiUserHost({ platform: "darwin", dsclOutput: SINGLE_USER_DSCL }),
    false,
    "one real mac account → single-user",
  );
  assert.equal(
    isMultiUserHost({ platform: "darwin", dsclOutput: MULTI_USER_DSCL }),
    true,
    "two real mac accounts → multi-user",
  );
  assert.equal(
    isMultiUserHost({ platform: "darwin", dsclOutput: null }),
    false,
    "dscl unavailable → single-user (conservative)",
  );

  // --- isMultiUserHost: Windows is not detected -------------------------------
  assert.equal(
    isMultiUserHost({ platform: "win32", passwdText: MULTI_USER_PASSWD }),
    false,
    "win32 detection is not implemented — always single-user",
  );

  // --- isMultiUserHost: env var overrides win over detection ------------------
  withEnv({ BIVY_MULTI_USER_HOST: "1" }, () => {
    assert.equal(
      isMultiUserHost({ platform: "linux", passwdText: SINGLE_USER_PASSWD }),
      true,
      "BIVY_MULTI_USER_HOST=1 forces true regardless of detection",
    );
  });
  withEnv({ BIVY_MULTI_USER_HOST: "0" }, () => {
    assert.equal(
      isMultiUserHost({ platform: "linux", passwdText: MULTI_USER_PASSWD }),
      false,
      "BIVY_MULTI_USER_HOST=0 forces false regardless of detection",
    );
  });

  // --- isAuthorized / resolveAuth: the actual auth-gate behavior -------------
  // A device token is always sufficient, loopback or not.
  assert.equal(
    isAuthorized(resolveAuth(fakeIdentity("device-1"), fakeReq("8.8.8.8"))),
    true,
    "valid device token authorizes a remote caller",
  );
  assert.equal(
    isAuthorized(resolveAuth(fakeIdentity(null), fakeReq("8.8.8.8"))),
    false,
    "no token, non-loopback → unauthorized",
  );

  // Loopback without a token: allowed by default (single-user host), denied
  // once BIVY_REQUIRE_LOCAL_AUTH=1 or the host looks multi-user.
  withEnv({ BIVY_REQUIRE_LOCAL_AUTH: undefined, BIVY_MULTI_USER_HOST: "0" }, () => {
    assert.equal(
      isAuthorized(resolveAuth(fakeIdentity(null), fakeReq("127.0.0.1"))),
      true,
      "loopback + no token + single-user host → authorized (today's default)",
    );
  });
  withEnv({ BIVY_REQUIRE_LOCAL_AUTH: "1", BIVY_MULTI_USER_HOST: undefined }, () => {
    assert.equal(
      isAuthorized(resolveAuth(fakeIdentity(null), fakeReq("127.0.0.1"))),
      false,
      "BIVY_REQUIRE_LOCAL_AUTH=1 → loopback bypass off even on a single-user host",
    );
  });
  withEnv({ BIVY_REQUIRE_LOCAL_AUTH: undefined, BIVY_MULTI_USER_HOST: "1" }, () => {
    assert.equal(
      isAuthorized(resolveAuth(fakeIdentity(null), fakeReq("127.0.0.1"))),
      false,
      "detected multi-user host → loopback bypass off by default (the fix for #111)",
    );
  });
  withEnv({ BIVY_REQUIRE_LOCAL_AUTH: "0", BIVY_MULTI_USER_HOST: "1" }, () => {
    assert.equal(
      isAuthorized(resolveAuth(fakeIdentity(null), fakeReq("127.0.0.1"))),
      true,
      "BIVY_REQUIRE_LOCAL_AUTH=0 forces the bypass back on even on a detected multi-user host",
    );
  });

  // resolveAuth's `loopback` field is the raw physical fact, independent of
  // policy — /api/git-credential and /api/auth/bootstrap rely on this so they
  // stay reachable (via their own secret gate) even when the general bypass
  // above is off.
  withEnv({ BIVY_REQUIRE_LOCAL_AUTH: "1" }, () => {
    const ctx = resolveAuth(fakeIdentity(null), fakeReq("127.0.0.1"));
    assert.equal(ctx.loopback, true, "ctx.loopback reflects the physical connection, not the auth policy");
    assert.equal(isAuthorized(ctx), false, "...but isAuthorized still denies it without a token");
  });

  console.log("auth: all tests passed");
}

run();
