// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/service-images.yml", import.meta.url), "utf8");

test("Core publishes a separate opt-in ephemeral UI image without replacing default artifacts", () => {
  assert.match(workflow, /image: bivy-control-plane\n\s+tag_suffix: -ephemerals\n\s+ephemerals: "1"/);
  assert.equal(workflow.match(/--build-arg "VITE_EPHEMERAL_MACHINES_ENABLED=\$\{\{ matrix\.ephemerals \|\| '0' \}\}"/g)?.length, 2, "validation and publication must use the same flag, default off");
  assert.match(workflow, /IMAGE_TAG: \$\{\{ needs.resolve.outputs.core_sha \}\}\$\{\{ matrix.tag_suffix \}\}/);
  assert.match(workflow, /imagetools inspect "\$IMAGE:\$IMAGE_TAG"/);
  assert.match(workflow, /--tag "\$IMAGE:\$IMAGE_TAG"/);
  assert.match(workflow, /--cache-to "type=registry,ref=\$IMAGE:buildcache\$\{\{ matrix.tag_suffix \}\},mode=max"/);
  assert.match(workflow, /"bivy-control-plane:\$CORE_SHA" "bivy-control-plane:\$CORE_SHA-ephemerals" "bivy-relay:\$CORE_SHA"/);
});

test("the opt-in variant is built on both supported architectures during PR validation", () => {
  const validation = workflow.split("\n  resolve:")[0];
  for (const arch of ["amd64", "arm64"]) {
    assert.match(validation, new RegExp(`tag_suffix: -ephemerals\\n\\s+ephemerals: "1"\\n\\s+arch: ${arch}`));
  }
  const dockerfile = readFileSync(new URL("../deploy/Dockerfile.control-plane", import.meta.url), "utf8");
  assert.match(dockerfile, /ARG VITE_EPHEMERAL_MACHINES_ENABLED/);
  assert.match(dockerfile, /ENV VITE_EPHEMERAL_MACHINES_ENABLED=\$VITE_EPHEMERAL_MACHINES_ENABLED/);
  assert.ok(dockerfile.indexOf("ARG VITE_EPHEMERAL_MACHINES_ENABLED") < dockerfile.indexOf("RUN pnpm --filter @bivy/web run build"));
});
