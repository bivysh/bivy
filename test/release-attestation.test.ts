// An archive install only takes an archive whose build attestation was made by
// Bivy's release workflow for that version and names that file and digest.
// The fixture is the real attestation GitHub holds for 0.21.16's linux-x64
// archive; Sigstore's own verification is stubbed so the suite runs offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { releaseRepo, verifyReleaseAttestation } from "../bin/release-attestation.mjs";

const fixture = fs.readFileSync(new URL("./fixtures/release-attestation-v0.21.16.json", import.meta.url), "utf8");
const genuine = {
  repo: "bivysh/bivy",
  version: "0.21.16",
  file: "bivy-0.21.16-linux-x64.tar.gz",
  sha256: "ad5a2c1cadc189169aa24f67045511dce0e406465cbf189f04a3e161b2c46f78",
};
const fetchImpl = (async () => new Response(fixture)) as typeof fetch;
function sigstore(outcome: "ok" | "bad" = "ok") {
  const calls: unknown[] = [];
  return { calls, verify: async (_bundle: unknown, options: unknown) => { calls.push(options); if (outcome === "bad") throw new Error("signature mismatch"); } };
}

test("an archive attested by the release workflow for its version verifies", async () => {
  const client = sigstore();
  await verifyReleaseAttestation({ ...genuine, fetchImpl, sigstore: client });
  assert.deepEqual(client.calls, [{
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: "https://github.com/bivysh/bivy/.github/workflows/release.yml@refs/tags/v0.21.16",
  }]);
});

test("an attestation for another version, file, digest or signer is refused before Sigstore runs", async () => {
  for (const wrong of [{ version: "0.21.17" }, { file: "bivy-0.21.16-darwin-arm64.tar.gz" }, { sha256: "0".repeat(64) }, { repo: "someone/bivy" }]) {
    const client = sigstore();
    await assert.rejects(verifyReleaseAttestation({ ...genuine, ...wrong, fetchImpl, sigstore: client }), /refusing to install/);
    assert.equal(client.calls.length, 0);
  }
});

test("a bundle Sigstore rejects, or no attestation at all, is refused", async () => {
  await assert.rejects(verifyReleaseAttestation({ ...genuine, fetchImpl, sigstore: sigstore("bad") }), /did not verify: signature mismatch/);
  const missing = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  await assert.rejects(verifyReleaseAttestation({ ...genuine, fetchImpl: missing, sigstore: sigstore() }), /no build attestation/);
});

test("only GitHub releases are held to an attestation", () => {
  assert.equal(releaseRepo("https://github.com/bivysh/bivy/releases"), "bivysh/bivy");
  assert.equal(releaseRepo("file:///tmp/releases"), undefined);
  assert.equal(releaseRepo("https://mirror.example/bivy/releases"), undefined);
});
