import assert from "node:assert/strict";
import { looksCatastrophic, looksBackstop, pathEscapesWorkspace, guardToolCall } from "../src/guard.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const noRisky = (_tool: string) => false;

check("catastrophic: rm -rf /", () => {
  assert.equal(looksCatastrophic("rm -rf /"), true);
  assert.equal(looksCatastrophic("sudo rm -rf ~"), true);
  assert.equal(looksCatastrophic("mkfs.ext4 /dev/sda1"), true);
  assert.equal(looksCatastrophic(":(){ :|:& };:"), true);
});

check("catastrophic: ordinary commands are not catastrophic", () => {
  assert.equal(looksCatastrophic("rm -rf node_modules"), false);
  assert.equal(looksCatastrophic("ls -la"), false);
  assert.equal(looksCatastrophic("npm install"), false);
});

check("backstop: publish/deploy/force-push/send/sudo", () => {
  assert.equal(looksBackstop("git push --force origin feature"), true);
  assert.equal(looksBackstop("git push origin main"), true);
  assert.equal(looksBackstop("npm publish"), true);
  assert.equal(looksBackstop("sudo apt-get install foo"), true);
  assert.equal(looksBackstop("kubectl apply -f deploy.yaml"), true);
  assert.equal(looksBackstop("sendmail user@example.com < body.txt"), true);
  assert.equal(looksBackstop("git push origin my-branch"), false);
  assert.equal(looksBackstop("npm test"), false);
});

check("backstop: integration send/spend tools always ask (autonomous)", () => {
  // Risky integration tools (send email, upload, charge) confirm regardless of
  // bash heuristics — this is the "send email / spend" half of the backstop.
  const isRisky = (tool: string) => tool === "gmail.send";
  assert.equal(guardToolCall("/ws", "gmail.send", { to: "x" }, "autonomous", isRisky).decision, "ask");
  assert.equal(guardToolCall("/ws", "notion.read", {}, "autonomous", isRisky).decision, "allow");
});

check("workspace boundary", () => {
  assert.equal(pathEscapesWorkspace("/home/u/ws", "src/a.ts"), false);
  assert.equal(pathEscapesWorkspace("/home/u/ws", "../secret"), true);
  assert.equal(pathEscapesWorkspace("/home/u/ws", "/etc/passwd"), true);
});

check("autonomous: ordinary tools run without prompting", () => {
  assert.equal(guardToolCall("/ws", "bash", { command: "npm test" }, "autonomous", noRisky).decision, "allow");
  assert.equal(guardToolCall("/ws", "write", { path: "src/a.ts" }, "autonomous", noRisky).decision, "allow");
  assert.equal(guardToolCall("/ws", "edit", { file_path: "src/a.ts" }, "autonomous", noRisky).decision, "allow");
});

check("autonomous: catastrophic blocked, backstop asks, escape blocked", () => {
  assert.equal(guardToolCall("/ws", "bash", { command: "rm -rf /" }, "autonomous", noRisky).decision, "deny");
  assert.equal(guardToolCall("/ws", "bash", { command: "git push origin main" }, "autonomous", noRisky).decision, "ask");
  assert.equal(guardToolCall("/ws", "write", { path: "../../etc/passwd" }, "autonomous", noRisky).decision, "deny");
});

check("floor applies even in never mode", () => {
  assert.equal(guardToolCall("/ws", "bash", { command: "rm -rf /" }, "never", noRisky).decision, "deny");
  assert.equal(guardToolCall("/ws", "bash", { command: "anything" }, "never", noRisky).decision, "allow");
});

check("risky mode keeps prompting on risky bash", () => {
  assert.equal(guardToolCall("/ws", "bash", { command: "curl http://x" }, "risky", noRisky).decision, "ask");
  assert.equal(guardToolCall("/ws", "bash", { command: "ls" }, "risky", noRisky).decision, "allow");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nautonomy: all tests passed");
