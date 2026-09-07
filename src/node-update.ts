import fs from "node:fs";
import path from "node:path";
import { gt, valid } from "semver";

/** Match the channel recorded by install.sh and `bivy update`. */
export function updateRegistryUrl(appDir: string, override?: string): string {
  if (override) return override;
  let channel = "latest";
  try {
    const recorded = fs.readFileSync(path.join(appDir, "channel"), "utf8").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recorded)) channel = recorded;
  } catch { /* Existing installs track stable. */ }
  return `https://registry.npmjs.org/%40bivy%2Fbivy/${encodeURIComponent(channel)}`;
}

export type NodeUpdateState = { type: "node.update"; current: string; latest?: string };

/** Running version is fixed for this process, never re-read after an install. */
export function createNodeUpdateChecker(options: {
  current: string;
  registryUrl: () => string;
  publish: (state: NodeUpdateState) => void;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  let state: NodeUpdateState = { type: "node.update", current: options.current };
  let checkedAt = -Infinity;
  let checkedUrl: string | undefined;
  let pending: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  async function check(): Promise<void> {
    if (pending) return pending;
    const url = options.registryUrl();
    if (url === checkedUrl && now() - checkedAt < 6 * 60 * 60 * 1000) return;
    pending = (async () => {
      try {
        const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const { version } = await response.json() as { version?: unknown };
        if (typeof version !== "string" || !valid(version) || !valid(options.current)) return;
        state = { type: "node.update", current: options.current,
          ...(gt(version, options.current) ? { latest: version } : {}) };
        checkedAt = now();
        checkedUrl = url;
        options.publish(state);
      } catch { /* A failed check is not evidence that an update disappeared. */ }
    })();
    try { await pending; } finally { pending = undefined; }
  }
  return { snapshot: () => ({ ...state }), check };
}
