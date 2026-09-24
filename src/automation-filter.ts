// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { parseAutomationFilter, type AutomationFilter } from "./automation-template.js";

export interface FilterInput {
  version: 1;
  event: { type: "webhook"; payload: Record<string, unknown> | unknown[] };
  delivery: { id: string };
}
export interface FilterResult {
  decision: "accept" | "skip";
  reason?: string;
  diagnostics: string;
}
export class AutomationFilterError extends Error {
  constructor(message: string, public readonly diagnostics = "") {
    super(message);
    this.name = "AutomationFilterError";
  }
}

/** The same input contract is used by local tests and live deliveries. No headers. */
export function webhookFilterInput(payload: unknown, deliveryId: string): FilterInput {
  if (!payload || typeof payload !== "object") throw new AutomationFilterError("Filter payload must be a JSON object or array");
  return { version: 1, event: { type: "webhook", payload: payload as FilterInput["event"]["payload"] }, delivery: { id: deliveryId } };
}

const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 16 * 1024;

/** Trusted operator code, NOT a sandbox. No shell or inherited credentials. */
export async function runAutomationFilter(config: AutomationFilter, input: FilterInput, signal?: AbortSignal): Promise<FilterResult> {
  const filter = parseAutomationFilter(config);
  if (signal?.aborted) throw new AutomationFilterError("Filter cancelled");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > INPUT_LIMIT) throw new AutomationFilterError("Filter input exceeds 256 KiB");
  return new Promise((resolve, reject) => {
    const child = spawn(filter.command[0]!, filter.command.slice(1), {
      cwd: filter.cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        LANG: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Also reap descendants that outlive a successful parent.
      kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AutomationFilterError(message, stderr.toString("utf8")));
    };
    const abort = () => fail("Filter cancelled");
    const timer = setTimeout(() => fail(`Filter timed out after ${filter.timeoutSeconds}s`), filter.timeoutSeconds * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => fail("Could not start filter executable or open its working directory"));
    // Early stdin closure is legal for filters that don't need the payload.
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > OUTPUT_LIMIT) { fail("Filter stdout exceeds 16 KiB"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > OUTPUT_LIMIT) { fail("Filter stderr exceeds 16 KiB"); return; }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { fail(`Filter exited unsuccessfully (${code ?? "signal"})`); return; }
      let data: Record<string, unknown>;
      try { data = JSON.parse(stdout.toString("utf8")); }
      catch { fail("Filter stdout must be one JSON decision object"); return; }
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          Object.keys(data).some(key => !["decision", "reason"].includes(key)) ||
          (data.decision !== "accept" && data.decision !== "skip") ||
          (data.reason !== undefined && (typeof data.reason !== "string" || data.reason.length > 500))) {
        fail("Filter output requires decision accept/skip and optional reason (at most 500 characters)");
        return;
      }
      settled = true;
      cleanup();
      resolve({ decision: data.decision as "accept" | "skip", reason: data.reason as string | undefined, diagnostics: stderr.toString("utf8") });
    });
    child.stdin.end(serialized);
  });
}
