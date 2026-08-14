import assert from "node:assert/strict";
import { BackgroundShellTracker, createBackgroundAwareBashOperations } from "../src/agents/pi/background-shell.js";

if (process.platform === "win32") {
  console.log("background-shell: skipped (POSIX process groups unavailable)");
} else {
  const tracker = new BackgroundShellTracker();
  const changes: number[] = [];
  tracker.subscribe((count) => changes.push(count));
  const operations = createBackgroundAwareBashOperations(tracker);

  await operations.exec("sleep 0.2 >/dev/null 2>&1 &", process.cwd(), { onData: () => {} });
  assert.equal(tracker.count, 1, "a process left in the shell group is tracked");

  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(tracker.count, 0, "the tracker clears after the process group exits");
  assert.deepEqual(changes, [1, 0]);
  tracker.dispose();
  console.log("background-shell: all tests passed");
}
