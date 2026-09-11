// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const scenario of ["ready", "slow", "stopped", "timeout", "installer-fails"]) {
  test(`installer smoke guest: ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-guest-test-"));
    try {
      fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "docker"), `#!/bin/sh
case "$1" in
  inspect)
    if [ "$3" = '{{json .State}}' ]; then echo '{"Running":false}';
    elif [ "$SCENARIO" = stopped ]; then echo false; else echo true; fi ;;
  logs) echo 'guest preparation logs' ;;
  exec)
    if [ "$3" = test ]; then
      count=0
      if [ -f "$FAKE_DIR/count" ]; then read -r count < "$FAKE_DIR/count"; fi
      count=$((count + 1)); echo "$count" > "$FAKE_DIR/count"
      if [ "$SCENARIO" = timeout ]; then exit 1; fi
      if [ "$SCENARIO" = slow ] && [ "$count" -lt 150 ]; then exit 1; fi
    else
      echo invoked > "$FAKE_DIR/installer"
      if [ "$SCENARIO" = installer-fails ]; then exit 7; fi
    fi ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
      const result = spawnSync("bash", ["scripts/installer-smoke-guest.sh", "test"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, SCENARIO: scenario }, encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, scenario === "ready" || scenario === "slow" ? 0 : scenario === "installer-fails" ? 7 : 1);
      assert.equal(fs.existsSync(path.join(dir, "installer")), !["timeout", "stopped"].includes(scenario));
      if (scenario === "timeout") {
        assert.equal(fs.readFileSync(path.join(dir, "count"), "utf8").trim(), "300");
        assert.match(result.stderr, /within 300 seconds/);
      }
      if (scenario === "stopped") assert.match(result.stderr, /exited before curl/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
