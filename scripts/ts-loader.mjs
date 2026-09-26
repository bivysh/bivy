// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Minimal TypeScript loader for the node test suites, used via `node --import`.
//
// It replaces `tsx` for `pnpm run test:unit`. The suites are ~300 short-lived
// processes, so what dominates the run is not transpiling — it is paying a
// loader's fixed startup cost 300 times. `tsx` spins up a loader thread and
// loads esbuild in every one of them, which measured at ~420ms before a single
// line of test code ran; on CI that was a quarter of the suite's whole CPU time.
//
// This hook does two things differently:
//   1. It uses the synchronous `module.registerHooks` API (Node >= 22.15), so
//      there is no loader thread and no message passing.
//   2. It caches transformed output on disk keyed by a hash of the source, so
//      esbuild is only ever loaded on a cache miss. A warm process transpiles
//      nothing at all and just reads the cached JavaScript.
//
// Path semantics are unchanged: modules keep their real URL, so `import.meta.url`
// and everything derived from it still points at the source file. That is what
// makes this a drop-in for tsx — 41 suites resolve fixtures and the repo root
// that way.
//
// Cache entries are content-addressed, so a stale entry cannot be served; the
// cache never needs invalidating and is safe to share between concurrent
// suites. Delete `node_modules/.cache/bivy-ts` to reclaim the space.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const CACHE_DIR = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "node_modules",
  ".cache",
  "bivy-ts",
);
mkdirSync(CACHE_DIR, { recursive: true });

// Bump when the transform options below change, so old entries are not reused.
const TRANSFORM_VERSION = 1;

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const isTypeScript = (filePath) => TS_EXTENSIONS.some((ext) => filePath.endsWith(ext));

function exists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// `esbuild` is only needed when a file is not already cached. Loading it costs
// more than the rest of this module put together, so keep it lazy: a warm run
// never touches it.
let transformSync;
function loadEsbuild() {
  if (!transformSync) ({ transformSync } = require("esbuild"));
  return transformSync;
}

function transform(source, filePath) {
  const key = createHash("sha1")
    .update(TRANSFORM_VERSION + "\0" + filePath + "\0" + source)
    .digest("hex");
  const cacheFile = path.join(CACHE_DIR, key + ".js");
  try {
    return readFileSync(cacheFile, "utf8");
  } catch {
    // cache miss — fall through and transpile
  }
  const { code } = loadEsbuild()(source, {
    loader: filePath.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    target: "node22",
    sourcefile: filePath,
    sourcemap: "inline",
    // `tsx` erases unused imports the same way; keep the behaviour identical so
    // side-effect-only type imports do not start being evaluated.
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: false } },
  });
  // Write via a unique temp name then rename: suites run concurrently, and a
  // torn read of a half-written cache entry would be a maddening flake.
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, code);
    renameSync(tmp, cacheFile);
  } catch {
    // A full or read-only disk must not fail the test run; just skip caching.
  }
  return code;
}

registerHooks({
  // TypeScript's NodeNext output keeps the `.js` specifier that the emitted
  // JavaScript would use, so `./rpc-protocol.js` has to find `rpc-protocol.ts`
  // when only the source exists. Try the real file first: a genuine `.js`
  // sibling (there are a few in `bin/` and `scripts/`) must still win.
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const parentPath = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
      const resolved = parentPath ? path.resolve(path.dirname(parentPath), specifier) : undefined;
      if (resolved && /\.(js|jsx|mjs|cjs)$/.test(resolved) && !exists(resolved)) {
        for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
          const candidate = resolved.replace(/\.(js|jsx|mjs|cjs)$/, ext);
          if (exists(candidate)) {
            return { url: pathToFileURL(candidate).href, format: "module", shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const filePath = fileURLToPath(url);
    if (!isTypeScript(filePath)) return nextLoad(url, context);
    return {
      format: "module",
      source: transform(readFileSync(filePath, "utf8"), filePath),
      shortCircuit: true,
    };
  },
});
