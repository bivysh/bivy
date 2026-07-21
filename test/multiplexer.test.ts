import assert from "node:assert/strict";
import { parseTmux, parseZellij, parseScreen, attachCommand } from "../src/multiplexer.js";

// tmux list-sessions -F '#{session_attached}:#{session_name}'
{
  const out = "1:work\n0:name with spaces\n0:has:colon\n";
  const sessions = parseTmux(out);
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions[0], { multiplexer: "tmux", name: "work", attached: true, target: "tmux:work" });
  assert.equal(sessions[1].name, "name with spaces", "fixed prefix preserves names with spaces");
  assert.equal(sessions[1].attached, false);
  assert.equal(sessions[2].name, "has:colon", "name may contain a colon");
}

// zellij list-sessions — colorized, with (current) and EXITED variants.
{
  const out = "\x1b[32mmain\x1b[0m [Created 1h ago] (current)\nside [Created 2h ago]\ndead (EXITED - attach to resurrect)\n";
  const sessions = parseZellij(out);
  assert.deepEqual(sessions.map((s) => s.name), ["main", "side"], "ANSI stripped; EXITED dropped");
  assert.equal(sessions[0].attached, true, "(current) marks attached");
  assert.equal(sessions[1].attached, false);
  assert.equal(sessions[0].target, "zellij:main");
}

// screen -ls
{
  const out = "There are screens on:\n\t12345.work\t(Detached)\n\t9.build\t(Attached)\n2 Sockets in /run/screen.\n";
  const sessions = parseScreen(out);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].name, "12345.work");
  assert.equal(sessions[0].attached, false);
  assert.equal(sessions[1].attached, true, "(Attached) marks attached");
  assert.equal(sessions[1].target, "screen:9.build");
}

// Attach command resolution.
assert.deepEqual(attachCommand("tmux", "work"), { command: "tmux", args: ["attach", "-t", "work"] });
assert.deepEqual(attachCommand("zellij", "main"), { command: "zellij", args: ["attach", "main"] });
assert.deepEqual(attachCommand("screen", "9.build"), { command: "screen", args: ["-r", "9.build"] });

console.log("multiplexer: ok (tmux/zellij/screen parsing + attach commands)");
