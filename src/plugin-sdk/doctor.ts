// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { checkPluginCompatibility, type PluginManifest } from "./manifest.js";

export interface PluginDoctorCheck {
  name: string;
  status: "pass" | "warning" | "fail";
  message: string;
  agentId?: string;
}

export interface PluginDoctorResult {
  ok: boolean;
  checks: PluginDoctorCheck[];
  errors: string[];
  warnings: string[];
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve an adapter command without invoking it. */
export function resolvePluginCommand(command: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const file = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return executable(file) ? file : undefined;
  }
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(directory, process.platform === "win32" ? `${command}${extension}` : command);
      if (executable(file)) return file;
    }
  }
  return undefined;
}

/** A Pi agent needs the operator's Pi and every local package it names. */
function doctorPiAdapter(agentId: string, packages: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): PluginDoctorCheck[] {
  const command = (opts.env ?? process.env).BIVY_PI_COMMAND?.trim() || "pi";
  const resolved = resolvePluginCommand(command, { cwd: opts.cwd, env: opts.env });
  const checks: PluginDoctorCheck[] = [{
    name: "executable",
    agentId,
    status: resolved ? "pass" : "fail",
    message: resolved ? `Pi (${command}) resolves to ${resolved}` : `Pi (${command}) was not found; install Pi on this node`,
  }];
  for (const source of packages) {
    const file = path.resolve(opts.cwd ?? process.cwd(), source);
    checks.push({
      name: "package",
      agentId,
      status: fs.existsSync(file) ? "pass" : "fail",
      message: fs.existsSync(file) ? `Pi package ${source} resolves to ${file}` : `Pi package ${source} was not found at ${file}`,
    });
  }
  return checks;
}

/** Static compatibility and executable diagnostics shared by CLI and tooling. */
export function doctorPluginManifest(
  manifest: PluginManifest,
  opts: { bivyVersion: string; cwd?: string; env?: NodeJS.ProcessEnv },
): PluginDoctorResult {
  const checks: PluginDoctorCheck[] = [];
  const compatibility = checkPluginCompatibility(manifest, opts.bivyVersion);
  checks.push({
    name: "compatibility",
    status: compatibility.compatible ? (compatibility.requiredRange ? "pass" : "warning") : "fail",
    message: compatibility.message,
  });

  for (const agent of manifest.contributes.agents) {
    if (agent.adapter.kind === "pi") {
      checks.push(...doctorPiAdapter(agent.id, agent.adapter.packages, opts));
      continue;
    }
    const resolved = resolvePluginCommand(agent.adapter.command, { cwd: opts.cwd, env: opts.env });
    checks.push({
      name: "executable",
      agentId: agent.id,
      status: resolved ? "pass" : "fail",
      message: resolved
        ? `${agent.adapter.command} resolves to ${resolved}`
        : `${agent.adapter.command} was not found or is not executable`,
    });
    checks.push({
      name: "adapter",
      agentId: agent.id,
      status: "pass",
      message: agent.adapter.kind === "acp"
        ? "ACP adapter is eligible for a live handshake test"
        : "Process adapter passed static conformance; Bivy will not invoke it during plugin test",
    });
  }

  const errors = checks.filter((check) => check.status === "fail").map((check) => check.message);
  const warnings = checks.filter((check) => check.status === "warning").map((check) => check.message);
  return { ok: errors.length === 0, checks, errors, warnings };
}
