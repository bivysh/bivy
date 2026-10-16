// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Install and update from the self-contained GitHub release archives
 * (scripts/release-archives.mjs). Layout under the install root
 * (default ~/.local/share/bivy):
 *
 *   versions/<version>-<target>/   one extracted archive each
 *   current -> versions/…          the active one, swapped atomically
 *
 * The launcher (current/bin/bivy) passes its unresolved `current` path as
 * BIVY_ARCHIVE_ROOT, so a service unit or shim written through it keeps
 * working after `current` moves to a new version.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const RELEASES_URL = "https://github.com/bivysh/bivy/releases";
export const ARCHIVE_INFO = "bivy-archive.json";
/** Versions kept on disk: the active one and the one before it, for rollback. */
const KEEP = 2;

/** "linux-x64" etc.: the archive target for this machine, or undefined. */
export function archiveTarget(platform = process.platform, arch = process.arch) {
  return ["linux", "darwin"].includes(platform) && ["x64", "arm64"].includes(arch) ? `${platform}-${arch}` : undefined;
}

/** Where a channel's manifest and archives live. `latest` is the newest stable release. */
export function channelUrls(channel, base = process.env.BIVY_RELEASES_URL || RELEASES_URL) {
  const dir = channel === "latest" ? `${base}/latest/download` : `${base}/download/${encodeURIComponent(channel)}`;
  return {
    manifest: `${dir}/manifest.json`,
    // Stable archives are fetched from their own tag, so a release published
    // mid-update can't swap the file under a manifest read a moment earlier.
    archive: (manifest, file) => (channel === "latest" ? `${base}/download/v${manifest.version}/${file}` : `${dir}/${file}`),
  };
}

/**
 * The archive install this CLI runs from, or null. `archiveRoot` is the
 * launcher's BIVY_ARCHIVE_ROOT; it only counts when it really is the install
 * holding `appRoot`, so a value inherited into some other checkout is ignored.
 */
export function archiveInstall(archiveRoot, appRoot) {
  if (!archiveRoot) return null;
  try {
    if (fs.realpathSync(path.join(archiveRoot, "app")) !== fs.realpathSync(appRoot)) return null;
    const info = JSON.parse(fs.readFileSync(path.join(archiveRoot, ARCHIVE_INFO), "utf8"));
    // Run as current/bin/bivy or as versions/<v>/bin/bivy, the install root is
    // the same, and `current` is the path worth writing down.
    const parent = path.dirname(archiveRoot);
    const installRoot = path.basename(archiveRoot) === "current" ? parent : path.basename(parent) === "versions" ? path.dirname(parent) : undefined;
    // An archive unpacked anywhere else runs, but has no install to update.
    const current = path.join(installRoot ?? "", "current");
    if (!installRoot || !fs.existsSync(current)) return null;
    // Run through `current`, write `current`; a specific version (say, a new one
    // being checked before the swap) stays itself.
    const root = fs.realpathSync(archiveRoot) === fs.realpathSync(current) ? current : archiveRoot;
    return { root, installRoot, version: info.version, target: info.target };
  } catch {
    return null;
  }
}

export async function fetchManifest(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Could not read the release manifest (${res.status} from ${url})`);
  const manifest = await res.json();
  if (typeof manifest?.version !== "string" || !manifest.archives) throw new Error(`${url} is not a Bivy release manifest`);
  return manifest;
}

/**
 * Fetch a large file with curl. Node's fetch can abort the process on an
 * assertion when a server closes the connection while the body is paused
 * for backpressure; curl is on every machine install.sh runs on.
 */
export function curlDownload(url, dest) {
  const res = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", dest, url], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`Could not download ${url}: ${(res.stderr || "").trim() || `curl exit ${res.status}`}`);
}

/**
 * Download, verify and extract one archive into versions/. Returns its
 * directory. Nothing outside versions/ changes, so a failure here leaves the
 * running install untouched.
 */
export async function stageArchive({ installRoot, manifest, target, archiveUrl, download = curlDownload }) {
  const entry = manifest.archives[target];
  if (!entry) throw new Error(`Bivy ${manifest.version} has no archive for ${target}`);
  const versions = path.join(installRoot, "versions");
  fs.mkdirSync(versions, { recursive: true });
  const work = fs.mkdtempSync(path.join(versions, ".stage-"));
  try {
    const tarball = path.join(work, entry.file);
    await download(archiveUrl(manifest, entry.file), tarball);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    if (sha256 !== entry.sha256) throw new Error(`${entry.file} failed verification: sha256 ${sha256}, the manifest says ${entry.sha256}`);

    const tar = spawnSync("tar", ["-xzf", tarball, "-C", work], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Could not extract ${entry.file}: ${tar.stderr}`);
    const extracted = path.join(work, entry.file.replace(/\.tar\.gz$/, ""));
    const info = JSON.parse(fs.readFileSync(path.join(extracted, ARCHIVE_INFO), "utf8"));
    if (info.version !== manifest.version || info.target !== target) throw new Error(`${entry.file} holds ${info.version} ${info.target}, not ${manifest.version} ${target}`);

    const dest = path.join(versions, `${manifest.version}-${target}`);
    // Re-staging a version (a reinstall) must not replace the directory `current`
    // points at while it runs; move it aside first and drop it afterwards.
    const aside = fs.existsSync(dest) ? `${dest}.old-${process.pid}` : undefined;
    if (aside) fs.renameSync(dest, aside);
    fs.renameSync(extracted, dest);
    if (aside) fs.rmSync(aside, { recursive: true, force: true });
    return dest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The version directory `current` points at, or undefined. */
export function activeVersion(installRoot) {
  try {
    return path.resolve(installRoot, fs.readlinkSync(path.join(installRoot, "current")));
  } catch {
    return undefined;
  }
}

/** Point `current` at a version directory atomically. Returns what it pointed at before. */
export function activate(installRoot, versionDir) {
  const previous = activeVersion(installRoot);
  const link = path.join(installRoot, "current");
  const next = `${link}.next-${process.pid}`;
  fs.rmSync(next, { force: true });
  fs.symlinkSync(path.relative(installRoot, versionDir), next);
  fs.renameSync(next, link);
  return previous;
}

/** Remove version directories other than the newest KEEP, never the active one. */
export function prune(installRoot, keep = []) {
  const versions = path.join(installRoot, "versions");
  const active = activeVersion(installRoot);
  const kept = new Set([...new Set([active, ...keep].filter(Boolean).map((p) => path.resolve(p)))].slice(0, KEEP));
  for (const name of fs.readdirSync(versions)) {
    const dir = path.join(versions, name);
    if (!kept.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
