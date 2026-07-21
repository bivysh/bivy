import assert from "node:assert/strict";
import { piSessionCommands } from "../src/runtime/pi.js";

// A fake AgentSession shaped like the Pi SDK's public accessors (extension
// commands + prompt templates + skills). piSessionCommands must normalize names
// to a leading slash, keep descriptions, prefix skills with "skill:", and dedupe.
const fakeSession = {
  extensionRunner: {
    getRegisteredCommands: () => [
      { invocationName: "compact", description: "Compact the conversation." },
      { invocationName: "/model", description: "Already slashed." }, // extra slash normalized
      { invocationName: "", description: "dropped — empty name" },
      { invocationName: "compact", description: "dup — first wins" },
    ],
  },
  promptTemplates: [
    { name: "review", description: "Review the diff." },
    { name: "nodesc" },
  ],
  _resourceLoader: {
    getSkills: () => ({ skills: [{ name: "deep-research", description: "Research harness." }] }),
  },
};

const commands = piSessionCommands(fakeSession);
assert.deepEqual(commands, [
  { name: "/compact", description: "Compact the conversation." },
  { name: "/model", description: "Already slashed." },
  { name: "/review", description: "Review the diff." },
  { name: "/nodesc" },
  { name: "/skill:deep-research", description: "Research harness." },
]);

// Malformed / empty inputs degrade to [] rather than throwing.
assert.deepEqual(piSessionCommands(undefined), []);
assert.deepEqual(piSessionCommands({}), []);
assert.deepEqual(piSessionCommands({ extensionRunner: { getRegisteredCommands: () => { throw new Error("boom"); } } }), []);

console.log("pi-commands: all tests passed");
