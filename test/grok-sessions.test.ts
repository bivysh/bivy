// Unit tests for Grok on-disk session discovery (src/runtime/grok-sessions.ts).
// Never touches a real ~/.grok — every path is under a temp GROK_HOME.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGrokSessionForCwd,
  listGrokSessions,
  loadGrokTranscript,
} from "../src/runtime/grok-sessions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-grok-sessions-"));
}

function writeSession(
  home: string,
  cwd: string,
  id: string,
  opts: { createdAt?: string; updatedAt?: string; title?: string; history?: string[] } = {},
): string {
  const dir = path.join(home, "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const created = opts.createdAt ?? "2026-08-08T10:00:00.000Z";
  const updated = opts.updatedAt ?? created;
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd },
      generated_title: opts.title ?? "Test session",
      created_at: created,
      updated_at: updated,
      last_active_at: updated,
    }),
  );
  const lines = opts.history ?? [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>\nnoise\n</user_info>" }] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nFix the bug\n</user_query>" }] }),
    JSON.stringify({ type: "assistant", content: "I'll look into it." }),
  ];
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), lines.join("\n") + "\n");
  return dir;
}

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

const home = tmpDir();
process.env.GROK_HOME = home;

await check("listGrokSessions reads summary + first user query", () => {
  writeSession(home, "/Users/me/proj", "sess-1", { title: "Bug hunt" });
  const listed = listGrokSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, "sess-1");
  assert.equal(listed[0]!.cwd, "/Users/me/proj");
  assert.equal(listed[0]!.name, "Bug hunt");
  assert.equal(listed[0]!.firstMessage, "Fix the bug");
});

await check("loadGrokTranscript drops meta wrappers and keeps real turns", () => {
  writeSession(home, "/Users/me/other", "sess-2");
  const messages = loadGrokTranscript("sess-2");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[0]!.content, "Fix the bug");
  assert.equal(messages[1]!.role, "assistant");
  assert.equal(messages[1]!.content, "I'll look into it.");
});

await check("discoverGrokSessionForCwd matches by cwd and start time", () => {
  const since = Date.parse("2026-08-08T12:00:00.000Z");
  writeSession(home, "/Users/me/work", "sess-old", {
    createdAt: "2026-08-08T09:00:00.000Z",
    title: "Old",
  });
  writeSession(home, "/Users/me/work", "sess-new", {
    createdAt: "2026-08-08T12:00:05.000Z",
    title: "New",
  });
  writeSession(home, "/Users/me/elsewhere", "sess-other", {
    createdAt: "2026-08-08T12:00:01.000Z",
    title: "Other cwd",
  });
  const match = discoverGrokSessionForCwd("/Users/me/work", since);
  assert.equal(match?.id, "sess-new");
});

await check("loadGrokTranscript returns [] for unknown id", () => {
  assert.deepEqual(loadGrokTranscript("does-not-exist"), []);
});

if (failures) {
  console.error(`grok-sessions: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("grok-sessions: all tests passed");
