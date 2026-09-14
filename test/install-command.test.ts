import assert from "node:assert/strict";
import { installCommand, isHostedControlPlane } from "../packages/web/src/installCommand.js";

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

// Same prerequisite installer, but environment MUST be on the bash side of the
// pipe so every self-hosted setup path stays on the operator's deployment.
assert.equal(isHostedControlPlane("https://bivy.example.com"), false);
const self = installCommand("https://bivy.example.com/", "wss://bivy.example.com/relay/", "sess_abc");
assert.equal(self.command, "curl -fsSL https://bivy.sh/install.sh | BIVY_SESSION_TOKEN=sess_abc BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://bivy.example.com/relay bash");
assert.equal(self.plainCommand, "curl -fsSL https://bivy.sh/install.sh | BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://bivy.example.com/relay bash");
assert.equal(installCommand("https://bivy.example.com/", "wss://relay.example.com/").command, "curl -fsSL https://bivy.sh/install.sh | BIVY_CONTROL_PLANE_URL=https://bivy.example.com BIVY_RELAY_URL=wss://relay.example.com bash");
const noRelay = installCommand("http://localhost:8080", "");
assert.equal(noRelay.hosted, false);
assert.equal(noRelay.authenticated, false);
assert.equal(noRelay.command, "curl -fsSL https://bivy.sh/install.sh | BIVY_CONTROL_PLANE_URL=http://localhost:8080 bash");
assert.equal(noRelay.plainCommand, noRelay.command);
assert.match(installCommand("https://x.example.com/a b").command, /BIVY_CONTROL_PLANE_URL='https:\/\/x\.example\.com\/a b'/);
assert.match(installCommand("https://x.example.com", null, "sess_'$(echo unsafe)").command, /BIVY_SESSION_TOKEN='sess_'\\''\$\(echo unsafe\)'/);
assert.equal(isHostedControlPlane("not a url"), false);
console.log("install-command: hosted/self-hosted endpoints, single-domain relay, auth and shell quoting passed");
