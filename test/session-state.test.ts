import assert from "node:assert/strict";
import { deriveSessionState } from "../src/session/session-state.js";

const idle = deriveSessionState({
  transportReachable: true,
  working: false,
  awaitingInput: false,
  workspace: "clean",
});
assert.deepEqual(idle, {
  transport: "reachable",
  process: "none",
  agent: "idle",
  workspace: "clean",
  displayStatus: "idle",
});

const working = deriveSessionState({
  transportReachable: false,
  processAlive: true,
  working: true,
  awaitingInput: false,
  workspace: "dirty",
  lastTurnFailed: true,
});
assert.deepEqual(working, {
  transport: "unreachable",
  process: "alive",
  agent: "working",
  workspace: "dirty",
  displayStatus: "working",
});

const waiting = deriveSessionState({
  transportReachable: true,
  working: false,
  waitingBackground: true,
  awaitingInput: false,
  workspace: "clean",
});
assert.equal(waiting.agent, "waiting");
assert.equal(waiting.displayStatus, "working", "background work must keep the session visibly active");

const awaiting = deriveSessionState({
  transportReachable: true,
  processAlive: true,
  working: true,
  awaitingInput: true,
  workspace: "checkpointing",
});
assert.equal(awaiting.agent, "awaiting-input");
assert.equal(awaiting.displayStatus, "needs_attention");

const dead = deriveSessionState({
  transportReachable: true,
  processAlive: false,
  working: true,
  awaitingInput: false,
  workspace: "dirty",
});
assert.equal(dead.process, "exited");
assert.equal(dead.displayStatus, "failed", "a known-dead child must not look working");

const failed = deriveSessionState({
  transportReachable: true,
  working: false,
  awaitingInput: false,
  workspace: "clean",
  lastTurnFailed: true,
});
assert.equal(failed.displayStatus, "failed");

console.log("session-state: all tests passed");
