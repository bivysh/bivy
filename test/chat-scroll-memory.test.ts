import assert from "node:assert/strict";
import { captureChatScroll, restoredChatScrollTop } from "../packages/web/src/chatScroll.js";

const memory = captureChatScroll({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 300 }, false, 60);
assert.deepEqual(memory, { distanceFromBottom: 100, pinned: false, limit: 60 });

assert.equal(
  restoredChatScrollTop({ scrollHeight: 1_500, scrollTop: 0, clientHeight: 300 }, memory),
  1_100,
  "restores the same distance from the bottom after background growth",
);
assert.equal(
  restoredChatScrollTop({ scrollHeight: 1_500, scrollTop: 0, clientHeight: 300 }, { ...memory, pinned: true }),
  1_500,
  "pinned sessions return to the latest content",
);
assert.equal(
  restoredChatScrollTop({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }, memory),
  0,
  "short content clamps to the top",
);

console.log("chat-scroll-memory: all tests passed");
