import fs from "node:fs";
import path from "node:path";
import { gt, valid } from "semver";

/** Match the channel recorded by install.sh and `bivy update`. */
/**
 * `{ manager, update }` when a system package manager owns this install (the
 * AUR's `bivy` writes `.bivy-install.json`, as bin/install-kind.mjs reads it for
 * the CLI), so the node must not replace its files; null otherwise.
 */
export function managedInstall(packageRoot: string): { manager: string; update: string } | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(packageRoot, ".bivy-install.json"), "utf8")) as { manager?: unknown; update?: unknown };
    if (typeof data.manager === "string" && data.manager) return { manager: data.manager, update: typeof data.update === "string" ? data.update : "" };
  } catch {
    /* not managed */
  }
  return null;
}

/**
 * True when this daemon runs from a GitHub release archive install: the
 * launcher's BIVY_ARCHIVE_ROOT names the install holding `packageRoot` (the
 * same check bin/archive-install.mjs makes for the CLI).
 */
export function isArchiveInstall(packageRoot: string, archiveRoot = process.env.BIVY_ARCHIVE_ROOT): boolean {
  if (!archiveRoot) return false;
  try {
    return fs.realpathSync(path.join(archiveRoot, "app")) === fs.realpathSync(packageRoot)
      && fs.existsSync(path.join(archiveRoot, "bivy-archive.json"));
  } catch {
    return false;
  }
}

/**
 * Where to look for a newer version on the install's recorded channel: the npm
 * registry, or for an archive install the channel's GitHub release manifest
 * (URLs as in bin/archive-install.mjs). Both answer with `{ version }`.
 */
export function updateRegistryUrl(appDir: string, override?: string, archive = false): string {
  if (override) return override;
  let channel = "latest";
  try {
    const recorded = fs.readFileSync(path.join(appDir, "channel"), "utf8").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recorded)) channel = recorded;
  } catch { /* Existing installs track stable. */ }
  if (archive) {
    const releases = process.env.BIVY_RELEASES_URL || "https://github.com/bivysh/bivy/releases";
    return channel === "latest" ? `${releases}/latest/download/manifest.json` : `${releases}/download/${encodeURIComponent(channel)}/manifest.json`;
  }
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
