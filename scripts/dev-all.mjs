#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// `pnpm dev:all`: everything needed to see a change on this machine — a node
// built from this checkout and the web app talking straight to it — with its
// own port and data dir, so a Bivy you already run is left alone. Ctrl-C stops
// both. Override with BIVY_DEV_NODE_PORT and BIVY_DEV_DATA_DIR.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.BIVY_DEV_NODE_PORT ?? "4390";
const dataDir = path.resolve(root, process.env.BIVY_DEV_DATA_DIR ?? ".bivy-dev");
const env = { ...process.env, BIVY_DEV_NODE_PORT: port };

const children = [
  { name: "node", color: 36, args: ["run", "dev"], env: { ...env, PORT: port, BIVY_DATA_DIR: dataDir } },
  { name: "web ", color: 35, args: ["run", "dev:web"], env },
].map(({ name, color, args, env: childEnv }) => {
  // Its own process group, so stopping it stops what pnpm started too.
  const child = spawn("pnpm", args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const prefix = `\x1b[${color}m${name}\x1b[0m │ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited (${code ?? "signal"})\n`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`Node on :${port} (data in ${path.relative(root, dataDir)}); open the app at http://localhost:5173/?local=1`);
