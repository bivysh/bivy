// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * The upstream package publishes an npm-shrinkwrap that pins vulnerable
 * transitive versions of undici and brace-expansion. Root-level npm overrides
 * repair the files in this repository, but dependency overrides do not flow to
 * consumers and a postinstall cannot update npm's final lockfile.
 *
 * Release tarballs therefore bundle a thin copy of pi itself (not its
 * node_modules or shrinkwrap) with the two safe versions in its manifest. npm
 * resolves the rest normally and records the actual safe graph, so both the
 * installed code and `npm audit` agree. The source package/version and MIT
 * license metadata remain intact.
 */
export function curateBundledPiManifest(piPkg, releasePkg) {
  const expected = releasePkg?.dependencies?.[PI_PACKAGE];
  if (!expected || piPkg?.version !== expected) {
    throw new Error(`Expected ${PI_PACKAGE}@${expected ?? "<missing>"}, found ${piPkg?.version ?? "<missing>"}`);
  }
  const brace = releasePkg?.dependencies?.["brace-expansion"];
  const undici = releasePkg?.dependencies?.undici;
  if (!brace || !undici) throw new Error("Release manifest must pin brace-expansion and undici");

  const out = {
    ...piPkg,
    dependencies: {
      ...piPkg.dependencies,
      "brace-expansion": brace,
      undici,
    },
  };
  delete out._resolved;
  delete out._integrity;
  return out;
}

export function stageBundledPi(root, app, releasePkg) {
  const source = path.join(root, "node_modules", ...PI_PACKAGE.split("/"));
  const destination = path.join(app, "node_modules", ...PI_PACKAGE.split("/"));
  if (!fs.existsSync(path.join(source, "package.json"))) {
    throw new Error(`${PI_PACKAGE} is not installed; run npm ci before building a release`);
  }

  fs.cpSync(source, destination, {
    recursive: true,
    filter(entry) {
      const relative = path.relative(source, entry);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return first !== "node_modules" && first !== "npm-shrinkwrap.json";
    },
  });

  const manifestPath = path.join(destination, "package.json");
  const piPkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, `${JSON.stringify(curateBundledPiManifest(piPkg, releasePkg), null, 2)}\n`);
}
