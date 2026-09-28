// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Agent bridges: the SDK packages Bivy loads in-process to drive an agent
// (Claude's Agent SDK, Pi's coding-agent library).
//
// They are large (hundreds of MB together) and a node usually needs one, so
// they are not installed with Bivy. They install on first use into a directory
// next to the node's state, which survives `bivy update` replacing the package
// directory, and resolve from there whenever Bivy's own node_modules lacks
// them. In a dev checkout the workspace installs them as optionalDependencies,
// so normal resolution finds them first and the bridge directory is unused.
//
// Plain JS (with a .d.mts) so the CLI in bin/ and the daemon share one copy.
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// npm is npm.cmd on Windows.
import { portableSpawn } from "./portable-process.mjs";

// src/ in a checkout, dist/ in a release: either way the parent is the package root.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which bridge packages each agent loads, and the CLI whose presence means the
 * agent is in use on this node. Adding a bridge is a row here plus a pinned
 * entry in package.json's optionalDependencies (published as `agentBridges`).
 */
export const AGENT_BRIDGES = {
  "claude-code-sdk": { command: "claude", packages: ["@anthropic-ai/claude-agent-sdk"] },
  pi: { command: "pi", packages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"] },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function bivyManifest() {
  return readJson(path.join(packageRoot, "package.json")) ?? {};
}

/** Pinned bridge versions: `agentBridges` in a release, optionalDependencies in a checkout. */
export function bridgeVersions() {
  const pkg = bivyManifest();
  return { ...(pkg.agentBridges ?? pkg.optionalDependencies ?? {}) };
}

/** Where bridges install: $BIVY_BRIDGES_DIR, else `bridges/` in the node's data dir. */
export function bridgesDir(env = process.env) {
  if (env.BIVY_BRIDGES_DIR) return path.resolve(env.BIVY_BRIDGES_DIR);
  const dataDir = env.BIVY_DATA_DIR ? path.resolve(env.BIVY_DATA_DIR) : path.join(packageRoot, ".bivy");
  return path.join(dataDir, "bridges");
}

/** "@scope/name/sub" -> "@scope/name"; "name/sub" -> "name". */
function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packageAt(dir) {
  const manifest = readJson(path.join(dir, "package.json"));
  return manifest ? { dir, version: manifest.version } : undefined;
}

/** Find `name` the way Node's resolver walks node_modules upward from `from`. */
function findUpward(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const found = packageAt(path.join(dir, "node_modules", name));
    if (found) return found;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * npm writes node_modules/.package-lock.json when an install finishes, and we
 * write package.json just before starting one. An interrupted install (the
 * daemon stopped mid-way) leaves half-extracted packages, so trust the
 * directory only when that lockfile is newer than the manifest.
 */
function installComplete(dir) {
  try {
    return fs.statSync(path.join(dir, "node_modules", ".package-lock.json")).mtimeMs >= fs.statSync(path.join(dir, "package.json")).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Where a bridge package resolves from, if anywhere: Bivy's own dependency
 * tree first (a checkout), then the bridge directory.
 */
export function resolveBridge(name, dir = bridgesDir()) {
  const own = findUpward(name, packageRoot);
  if (own) return { ...own, source: "bivy" };
  if (!installComplete(dir)) return undefined;
  const bridged = packageAt(path.join(dir, "node_modules", name));
  return bridged ? { ...bridged, source: "bridges" } : undefined;
}

export function bridgeInstalled(name, dir) {
  return resolveBridge(name, dir) !== undefined;
}

/** Bridge packages `agentId` needs that are not resolvable yet (none for agents without a bridge). */
export function missingBridges(agentId, dir) {
  return (AGENT_BRIDGES[agentId]?.packages ?? []).filter((name) => !bridgeInstalled(name, dir));
}

function onPath(command, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

/**
 * Bridge packages that should be (re)installed now: every package already in
 * the bridge directory or belonging to an agent whose CLI is on PATH, that is
 * either missing or not at Bivy's pinned version. Empty means nothing to do,
 * and computing it touches no network.
 */
export function bridgesToSync({ dir = bridgesDir(), commandExists = onPath } = {}) {
  const versions = bridgeVersions();
  const wanted = new Set(Object.keys(readJson(path.join(dir, "package.json"))?.dependencies ?? {}));
  for (const bridge of Object.values(AGENT_BRIDGES)) {
    if (commandExists(bridge.command)) bridge.packages.forEach((name) => wanted.add(name));
  }
  return [...wanted].filter((name) => {
    if (!versions[name]) return false;
    const found = resolveBridge(name, dir);
    return !found || (found.source === "bridges" && found.version !== versions[name]);
  });
}

/**
 * Replace nested copies that a bridge's own npm-shrinkwrap pins, which npm
 * `overrides` cannot reach. Driven by the nested overrides in package.json
 * (`"parent": { "child": "version" }`), so a new pin is data, not code.
 */
function applyNestedOverrides(dir) {
  for (const [parent, pins] of Object.entries(bivyManifest().overrides ?? {})) {
    if (!pins || typeof pins !== "object") continue;
    const parentDir = path.join(dir, "node_modules", parent);
    for (const [child, version] of Object.entries(pins)) {
      const target = path.join(parentDir, "node_modules", child);
      const nested = packageAt(target);
      if (!nested || nested.version === version) continue;
      const source = [packageAt(path.join(dir, "node_modules", child)), findUpward(child, packageRoot)]
        .find((candidate) => candidate?.version === version);
      if (!source) throw new Error(`Security patch source ${child}@${version} is missing`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source.dir, target, { recursive: true });
    }
  }
}

/**
 * Install `names` (at Bivy's pinned versions) into the bridge directory. The
 * directory is an ordinary npm project that keeps earlier bridges and carries
 * Bivy's security overrides. Optional dependencies are omitted: bridges run as
 * libraries against the operator's own agent CLI, never their bundled binaries.
 *
 * `stdio: "inherit"` streams npm's output (CLI); otherwise it is captured.
 * Installs in one process run one at a time, since they share a directory.
 */
let installQueue = Promise.resolve();
export function installBridges(names, options = {}) {
  const run = installQueue.then(() => installNow(names, options));
  installQueue = run.catch(() => {});
  return run;
}

function installNow(names, { dir = bridgesDir(), stdio = "pipe" } = {}) {
  const versions = bridgeVersions();
  const unknown = names.filter((name) => !versions[name]);
  if (unknown.length) return Promise.reject(new Error(`Not an agent bridge: ${unknown.join(", ")}`));

  fs.mkdirSync(dir, { recursive: true });
  // npm does not repair half-extracted packages, so an interrupted earlier
  // install is discarded rather than installed over.
  if (!installComplete(dir)) fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  const manifestPath = path.join(dir, "package.json");
  const previous = readJson(manifestPath)?.dependencies ?? {};
  const dependencies = { ...previous };
  for (const name of names) dependencies[name] = versions[name];
  const manifest = { name: "bivy-agent-bridges", private: true, dependencies, overrides: bivyManifest().overrides ?? {} };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return new Promise((resolve, reject) => {
    const child = portableSpawn("npm", ["install", "--omit=optional", "--no-audit", "--no-fund"], {
      cwd: dir,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => { output = (output + chunk.toString()).slice(-12000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`npm could not install ${names.join(", ")} (exit ${code ?? "unknown"})${output ? `\n${output}` : ""}`));
        return;
      }
      try {
        applyNestedOverrides(dir);
        resolve({ installed: names, output });
      } catch (error) {
        reject(error);
      }
    });
  });
}

const NOT_FOUND = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

// Same fallback as the in-thread hook below, for Node versions that only have
// module.register (off-thread, async hooks loaded from this data: URL).
const ASYNC_HOOKS = `
let parentURL, names;
export function initialize(data) { parentURL = data.parentURL; names = new Set(data.names); }
const nameOf = ${packageNameOf.toString()};
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (error) {
    if (!${JSON.stringify([...NOT_FOUND])}.includes(error?.code) || !names.has(nameOf(specifier))) throw error;
    try { return await next(specifier, { ...context, parentURL }); } catch { throw error; }
  }
}`;

let resolutionEnabled = false;

/**
 * Let `import`/`require` of a bridge package fall back to the bridge directory
 * when Bivy's own node_modules lacks it. Idempotent; call before loading a
 * bridge. Only bridge package names are redirected, and only after normal
 * resolution fails, so a checkout's workspace copies always win.
 */
export function enableBridgeResolution(dir = bridgesDir()) {
  if (resolutionEnabled) return;
  resolutionEnabled = true;
  const parentURL = pathToFileURL(path.join(dir, "package.json")).href;
  const names = Object.keys(bridgeVersions());
  if (typeof module.registerHooks === "function") {
    const bridges = new Set(names);
    module.registerHooks({
      resolve(specifier, context, next) {
        try {
          return next(specifier, context);
        } catch (error) {
          if (!NOT_FOUND.has(error?.code) || !bridges.has(packageNameOf(specifier))) throw error;
          try {
            return next(specifier, { ...context, parentURL });
          } catch {
            throw error;
          }
        }
      },
    });
  } else if (typeof module.register === "function") {
    module.register(`data:text/javascript,${encodeURIComponent(ASYNC_HOOKS)}`, { data: { parentURL, names } });
  }
}
