// `bivy restart` with a service unit that has drifted from what this install
// would write (an update moved paths, a config edit changed the env): the unit
// is rewritten and the running node is restarted too. `enable --now` alone only
// starts a stopped unit, so a running node kept its old code while the CLI said
// "Service restarted".
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("restart rewrites a drifted systemd unit and restarts the running node", { skip: process.platform !== "linux" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-restart-"));
  try {
    const bin = path.join(home, "fake-bin");
    const log = path.join(home, "systemctl.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "loginctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const data = path.join(home, ".bivy");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "cli.json"), JSON.stringify({ port: 47913, workspace: home, service: true }));
    const unit = path.join(home, ".config", "systemd", "user", "bivy.service");
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, "[Service]\nExecStart=/old/node /old/dist/server.js\n");

    const res = spawnSync(process.execPath, [path.join(root, "bin", "bivy.mjs"), "restart", "--force"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, BIVY_DATA_DIR: data, NO_COLOR: "1" },
      timeout: 60_000,
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.doesNotMatch(fs.readFileSync(unit, "utf8"), /\/old\/node/);
    assert.match(fs.readFileSync(log, "utf8"), /--user restart bivy\.service/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
