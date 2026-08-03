import assert from "node:assert/strict";
import { stripAnsi } from "../src/runtime/ansi.js";

// Dumb-pipe CLI agents colorize stdout/stderr with ANSI escapes that render as
// garbage (`[91m[1m…`) in the plain-text agent-output pane. stripAnsi removes
// them at display time while leaving ordinary text — including the JSON payload
// of an error envelope — byte-for-byte intact.

const ESC = "";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

check("strips SGR color codes, leaving the text", () => {
  const input = `${ESC}[91m${ESC}[1mError: ${ESC}[0mboom`;
  assert.equal(stripAnsi(input), "Error: boom");
});

check("reproduces the real OpenCode error line, cleaned", () => {
  const input = `${ESC}[91m${ESC}[1mError: ${ESC}[0m{ "name": "UnknownError", "data": { "message": "Unexpected server error. Check server logs for details.", "ref": "err_25799b27" } }`;
  const out = stripAnsi(input);
  assert.ok(!out.includes(ESC), "no escape characters remain");
  assert.ok(!/\[\d+m/.test(out), "no bare SGR fragments remain");
  assert.ok(out.startsWith("Error: {"), `unexpected: ${JSON.stringify(out)}`);
  assert.ok(out.includes(`"ref": "err_25799b27"`), "the JSON payload survives untouched");
});

check("strips 24-bit color and cursor-move sequences", () => {
  const input = `${ESC}[38;2;255;0;0mred${ESC}[0m${ESC}[2Kline`;
  assert.equal(stripAnsi(input), "redline");
});

check("leaves plain text (incl. brackets/newlines) unchanged", () => {
  const input = "no escapes here [not-ansi] { json: true }\nsecond line";
  assert.equal(stripAnsi(input), input);
});

check("is a no-op on the empty string", () => {
  assert.equal(stripAnsi(""), "");
});

if (failures > 0) {
  console.error(`\n${failures} ansi test(s) failed`);
  process.exit(1);
}
console.log("\nall ansi tests passed");
