// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { curateBundledPiManifest, PI_PACKAGE } from "../scripts/bundle-pi.mjs";

const releasePkg = {
  dependencies: {
    [PI_PACKAGE]: "0.83.0",
    "brace-expansion": "5.0.9",
    undici: "8.9.0",
  },
};
const upstream = {
  name: PI_PACKAGE,
  version: "0.83.0",
  license: "MIT",
  repository: { url: "https://github.com/earendil-works/pi.git" },
  dependencies: { glob: "13.0.6", undici: "8.5.0" },
  _resolved: "https://registry.example/pi.tgz",
  _integrity: "sha512-old",
};

const bundled = curateBundledPiManifest(upstream, releasePkg);
assert.equal(bundled.name, PI_PACKAGE);
assert.equal(bundled.version, "0.83.0");
assert.equal(bundled.license, "MIT");
assert.deepEqual(bundled.repository, upstream.repository);
assert.equal(bundled.dependencies.glob, "13.0.6");
assert.equal(bundled.dependencies.undici, "8.9.0");
assert.equal(bundled.dependencies["brace-expansion"], "5.0.9");
assert.ok(!("_resolved" in bundled));
assert.ok(!("_integrity" in bundled));
assert.equal(upstream.dependencies.undici, "8.5.0", "input must not be mutated");

assert.throws(
  () => curateBundledPiManifest({ ...upstream, version: "0.82.1" }, releasePkg),
  /Expected .*0\.83\.0, found 0\.82\.1/,
);
assert.throws(
  () => curateBundledPiManifest(upstream, { dependencies: { [PI_PACKAGE]: "0.83.0" } }),
  /must pin brace-expansion and undici/,
);

console.log("bundle-pi: thin manifest keeps provenance and pins safe dependencies");
