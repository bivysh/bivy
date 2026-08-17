// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Machine capability inventory controller (alongside controllers/workspaces.ts,
// controllers/models.ts). Assembles the bounded, non-sensitive
// MachineCapabilities snapshot from Bivy's existing
// canonical stores — server.ts adapts the real agent registry, credential
// vault, local-model registry, plugin store, and saved-workspace list into
// the plain fact shapes below — plus two short, cached, timeout-protected
// probes for Docker and GPU. This is capability discovery, not deep scanning:
// no file enumeration, no process command lines, no secrets, no active
// network probing of local model endpoints.
//
// Imports nothing from server.ts (boundary enforced).
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeCapabilities,
  type CapabilityAgentSummary,
  type CapabilityPluginSummary,
  type CapabilityProbeResult,
  type MachineCapabilities,
} from "../capabilities.js";

const execFileP = promisify(execFile);

/** Bounded so a probe can never hang the endpoint/CLI: `execFile`'s `timeout`
 *  option kills the child and rejects once this elapses. */
const PROBE_TIMEOUT_MS = 1500;
/** Probes shell out; cache briefly so repeated CLI/PWA refreshes within a
 *  short window don't re-spawn Docker/nvidia-smi on every call. */
const PROBE_CACHE_TTL_MS = 30_000;

async function defaultProbeDocker(): Promise<CapabilityProbeResult> {
  try {
    const { stdout } = await execFileP("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: PROBE_TIMEOUT_MS });
    const version = stdout.trim();
    return version ? { state: "available", detail: `Docker ${version}` } : { state: "unavailable", detail: "Docker daemon did not report a version" };
  } catch (error) {
    return classifyShellProbeError(error, "Docker");
  }
}

async function defaultProbeGpu(): Promise<CapabilityProbeResult> {
  // Every Mac ships a GPU (integrated or discrete) capable of Metal — safe to
  // report without a deeper, vendor-specific scan.
  if (process.platform === "darwin") return { state: "available", detail: "Apple GPU (Metal)" };
  try {
    const { stdout } = await execFileP("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: PROBE_TIMEOUT_MS });
    const name = stdout.trim().split("\n")[0]?.trim();
    return name ? { state: "available", detail: name } : { state: "unknown" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    if (err?.killed || err?.signal) return { state: "unknown", detail: "GPU probe timed out" };
    // No nvidia-smi (ENOENT) or a non-zero exit: this only rules out an
    // NVIDIA GPU. Bivy does not deep-scan for AMD/Intel GPUs, so the honest
    // answer is "unknown", never a guessed "unavailable".
    return { state: "unknown", detail: "No NVIDIA GPU detected; other vendors are not probed" };
  }
}

function classifyShellProbeError(error: unknown, label: string): CapabilityProbeResult {
  const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  if (err?.code === "ENOENT") return { state: "unavailable", detail: `${label} is not installed` };
  if (err?.killed || err?.signal) return { state: "unknown", detail: `${label} probe timed out` };
  return { state: "unavailable", detail: `${label} daemon is not reachable` };
}

export interface CapabilitiesControllerDeps {
  listAgents(): CapabilityAgentSummary[];
  listConfiguredProviderIds(): Promise<string[]> | string[];
  listLocalEndpoints(): Promise<Array<{ id: string; modelCount: number }>> | Array<{ id: string; modelCount: number }>;
  listPlugins(): CapabilityPluginSummary[];
  countWorkspaces(): number;
  /** Overridable for tests (deterministic success/timeout/failure); defaults
   *  to a real, timeout-protected `docker` probe. */
  probeDocker?(): Promise<CapabilityProbeResult>;
  /** Overridable for tests; defaults to a real, timeout-protected GPU probe. */
  probeGpu?(): Promise<CapabilityProbeResult>;
  /** Injectable clock for deterministic cache-TTL tests. */
  now?(): number;
}

export function createCapabilitiesController(deps: CapabilitiesControllerDeps) {
  const probeDocker = deps.probeDocker ?? defaultProbeDocker;
  const probeGpu = deps.probeGpu ?? defaultProbeGpu;
  const now = deps.now ?? (() => Date.now());

  let dockerCache: { at: number; value: CapabilityProbeResult } | null = null;
  let gpuCache: { at: number; value: CapabilityProbeResult } | null = null;

  async function cachedProbe(kind: "docker" | "gpu", run: () => Promise<CapabilityProbeResult>): Promise<CapabilityProbeResult> {
    const cache = kind === "docker" ? dockerCache : gpuCache;
    const at = now();
    if (cache && at - cache.at < PROBE_CACHE_TTL_MS) return cache.value;
    // A probe that itself rejects unexpectedly (rather than resolving a
    // classified result) must still degrade to an honest "unknown", not crash
    // the whole snapshot.
    let value: CapabilityProbeResult;
    try {
      value = await run();
    } catch {
      value = { state: "unknown" };
    }
    const entry = { at, value };
    if (kind === "docker") dockerCache = entry;
    else gpuCache = entry;
    return value;
  }

  async function getCapabilities(): Promise<MachineCapabilities> {
    const [configuredProviderIds, localEndpoints, docker, gpu] = await Promise.all([
      deps.listConfiguredProviderIds(),
      deps.listLocalEndpoints(),
      cachedProbe("docker", probeDocker),
      cachedProbe("gpu", probeGpu),
    ]);
    return normalizeCapabilities({
      os: { platform: os.platform(), arch: os.arch(), release: os.release(), type: os.type() },
      agents: deps.listAgents(),
      configuredProviderIds,
      localEndpoints,
      docker,
      gpu,
      plugins: deps.listPlugins(),
      workspaceCount: deps.countWorkspaces(),
      now: now(),
    });
  }

  return { getCapabilities };
}
