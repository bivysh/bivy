import assert from "node:assert/strict";
import { installCommand, isHostedControlPlane } from "../packages/web/src/installCommand.js";

// Hosted control plane (and its environments) → the one-line installer, with
// the downloadable /install.sh still offered.
assert.equal(isHostedControlPlane("https://app.bivy.sh"), true);
assert.equal(isHostedControlPlane("https://staging.app.bivy.sh"), true);
assert.deepEqual(installCommand("https://app.bivy.sh", "wss://relay.bivy.sh"), {
  command: "curl -fsSL https://bivy.sh/install.sh | bash",
  plainCommand: "curl -fsSL https://bivy.sh/install.sh | bash",
  hosted: true,
  authenticated: false,
});
assert.deepEqual(installCommand("https://app.bivy.sh", "wss://relay.bivy.sh", "sess_abc"), {
  command: "curl -fsSL https://bivy.sh/install.sh | BIVY_SESSION_TOKEN=sess_abc BIVY_CONTROL_PLANE_URL=https://app.bivy.sh BIVY_RELAY_URL=wss://relay.bivy.sh bash",
  plainCommand: "curl -fsSL https://bivy.sh/install.sh | bash",
  hosted: true,
  authenticated: true,
});

// Self-hosted control plane → point `bivy setup` at *this* deployment; the
// hosted installer would enroll the node on app.bivy.sh instead.
assert.equal(isHostedControlPlane("https://bivy.example.com"), false);
assert.equal(
  installCommand("https://bivy.example.com/", "wss://relay.example.com/").command,
  "npm install -g @bivy/bivy && BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://relay.example.com bivy setup",
);
const selfHostedAuthed = installCommand("https://bivy.example.com/", "wss://relay.example.com/", "sess_abc");
assert.equal(
  selfHostedAuthed.command,
  "npm install -g @bivy/bivy && BIVY_SESSION_TOKEN=sess_abc BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://relay.example.com bivy setup",
);
assert.equal(
  selfHostedAuthed.plainCommand,
  "npm install -g @bivy/bivy && BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://relay.example.com bivy setup",
);
// Relay unknown → only the control plane is pinned (setup asks for the relay).
const noRelay = installCommand("http://localhost:8080", "");
assert.equal(noRelay.hosted, false);
assert.equal(noRelay.authenticated, false);
assert.equal(noRelay.command, "npm install -g @bivy/bivy && BIVY_CONTROL_PLANE_URL=http://localhost:8080 bivy setup");
assert.equal(noRelay.plainCommand, noRelay.command);
// Odd characters are shell-quoted rather than pasted raw.
assert.match(installCommand("https://x.example.com/a b").command, /BIVY_CONTROL_PLANE_URL='https:\/\/x\.example\.com\/a b'/);
assert.equal(isHostedControlPlane("not a url"), false);
console.log("install-command: ok");
