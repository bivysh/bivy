import assert from "node:assert/strict";
import { HOSTED_INSTALL_CMD, installCommand, isHostedControlPlane } from "../packages/web/src/installCommand.js";

// Hosted control plane (and its environments) → the one-line installer, with
// the downloadable /install.sh still offered.
assert.equal(isHostedControlPlane("https://app.bivy.sh"), true);
assert.equal(isHostedControlPlane("https://staging.app.bivy.sh"), true);
assert.deepEqual(installCommand("https://app.bivy.sh", "wss://relay.bivy.sh"), { command: HOSTED_INSTALL_CMD, hosted: true });

// Self-hosted control plane → point `bivy setup` at *this* deployment; the
// hosted installer would enroll the node on app.bivy.sh instead.
assert.equal(isHostedControlPlane("https://bivy.example.com"), false);
assert.equal(
  installCommand("https://bivy.example.com/", "wss://relay.example.com/").command,
  "npm install -g @bivy/bivy && BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://relay.example.com bivy setup",
);
// Relay unknown → only the control plane is pinned (setup asks for the relay).
const noRelay = installCommand("http://localhost:8080", "");
assert.equal(noRelay.hosted, false);
assert.equal(noRelay.command, "npm install -g @bivy/bivy && BIVY_CONTROL_PLANE_URL=http://localhost:8080 bivy setup");
// Odd characters are shell-quoted rather than pasted raw.
assert.match(installCommand("https://x.example.com/a b").command, /BIVY_CONTROL_PLANE_URL='https:\/\/x\.example\.com\/a b'/);
assert.equal(isHostedControlPlane("not a url"), false);
console.log("install-command: ok");
