#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * bivy — one-command CLI for a Bivy node.
 *
 * Collapses the old multi-step node setup (clone, npm install, model login,
 * relay-setup with long flags, npm run dev, hand-written launchd/systemd files)
 * into a single guided flow:
 *
 *   bivy setup     first-run wizard: agent, model login, remote sign-in, background service
 *   bivy start     run the daemon in the foreground
 *   bivy stop      stop the background service
 *   bivy restart   restart the background service (waits for active sessions to finish; --force to skip)
 *   bivy status    show config + whether the node is reachable
 *   bivy login     sign into a model provider (native Pi /login)
 *   bivy update    update Bivy + install deps + restart service (waits for active sessions to finish; --force to skip)
 *   bivy update:log  show output of the last (or in-progress) update
 *   bivy open      open the browser UI
 *   bivy relay:setup        enable secure remote web/PWA access (one-click sign-in)
 *   bivy service install|uninstall|status   manage the background service
 *
 * No external dependencies: Node built-ins only. The daemon itself runs via the
 * bundled tsx, so there is no build step.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { selectStaleSessions, sessionActivityMs } from "./prune-sessions.mjs";
import { resolveSessionsLimit, truncateSavedSessions } from "./sessions-list.mjs";
import { renderManagedBlock, upsertManagedBlock, removeManagedBlock, rcFileForShell } from "./shim-path.mjs";
import { removeInstallAndState } from "./uninstall-paths.mjs";
import { findAvailablePort, reconcilePort } from "./port-picker.mjs";
import { resolveAttachSessionId } from "./attach-session-id.mjs";

const selfScript = fileURLToPath(import.meta.url);
const __dirname = path.dirname(selfScript);
const repoRoot = path.resolve(__dirname, "..");
// Mutable node state (config, relay E2E keys, sessions, logs) must live in a
// stable, user-owned directory that survives reinstalls. Pick it by install type:
//   - BIVY_DATA_DIR set                         -> honor it (explicit override)
//   - git dev checkout, or an existing
//     <repoRoot>/.bivy (an install.sh tree lives
//     in a user-owned dir and preserves .bivy
//     across updates)                           -> keep state co-located
//   - otherwise (npm i -g / npx: the package dir
//     may be root-owned and is replaced on
//     update, wiping state)                     -> ~/.bivy
function resolveAppDir() {
  if (process.env.BIVY_DATA_DIR) return path.resolve(process.env.BIVY_DATA_DIR);
  const local = path.join(repoRoot, ".bivy");
  if (fs.existsSync(local) || fs.existsSync(path.join(repoRoot, ".git"))) return local;
  return path.join(os.homedir(), ".bivy");
}
const appDir = resolveAppDir();
// Propagate the resolved data dir to every child process (daemon, native-pi,
// exec, …) via the environment so none of them independently fall back to
// <repoRoot>/.bivy. The daemon reads BIVY_DATA_DIR (see src/server.ts).
process.env.BIVY_DATA_DIR = appDir;

// How was this CLI installed? Governs update strategy and whether a persistent
// background service can point at repoRoot:
//   - "git"        dev checkout (has .git)
//   - "npx"        ephemeral `npx bivy` run (repoRoot under an npm _npx cache)
//   - "npm-global" `npm i -g @bivy/bivy` (repoRoot's parent dir is node_modules)
//   - "packaged"   install.sh tarball tree (user-owned, self-preserving)
function detectInstallKind() {
  if (fs.existsSync(path.join(repoRoot, ".git"))) return "git";
  const inNodeModules = path.basename(path.dirname(repoRoot)) === "node_modules";
  if (inNodeModules && /[\\/]_npx[\\/]/.test(repoRoot)) return "npx";
  if (inNodeModules) return "npm-global";
  return "packaged";
}
const cliConfigPath = path.join(appDir, "cli.json");
const canonicalConfigPath = path.join(appDir, "config.yaml");
let canonicalConfig = null;
async function hydrateCanonicalConfig() {
  if (!fs.existsSync(canonicalConfigPath)) return;
  try {
    const { parse } = await import("yaml");
    const value = parse(fs.readFileSync(canonicalConfigPath, "utf8"), { uniqueKeys: true });
    if (!value || typeof value !== "object" || value.version !== 1) throw new Error("version must be 1");
    canonicalConfig = value;
  } catch (error) {
    throw new Error(`Invalid ${canonicalConfigPath}: ${error?.message || String(error)}. Run 'bivy config validate'.`);
  }
}
const relayConfigPath = path.join(appDir, "relay.json");
// Short-lived handoff: relay:setup writes the account session it just obtained
// here (0600) so `bivy setup` can open the remote app signed into the *account*
// (all nodes), not a node-scoped link grant that would show only this node.
// Read once and deleted immediately — never a credential left at rest.
const setupSessionPath = path.join(appDir, ".setup-session.json");
const updateLogPath = path.join(appDir, "update.log");
// The release channel (npm dist-tag) this install tracks, recorded at install
// time by install.sh and here by `bivy update --channel`. Absent = `latest`, so
// existing installs keep behaving exactly as before.
const channelPath = path.join(appDir, "channel");
function readChannel() {
  try {
    const ch = fs.readFileSync(channelPath, "utf8").trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ch) ? ch : "latest";
  } catch {
    return "latest";
  }
}
function writeChannel(ch) {
  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(channelPath, `${ch}\n`);
  } catch {
    /* best-effort: an unwritable data dir just means update uses the default */
  }
}
// Pick the channel for an update: an explicit --stable/--staging/--channel flag
// wins and is PERSISTED (so later plain `bivy update`s stay on it); otherwise use
// the recorded channel (default `latest`). Returns a validated tag.
function resolveUpdateChannel(args) {
  let ch = null;
  if (args.includes("--stable")) ch = "latest";
  else if (args.includes("--staging")) ch = "staging";
  else {
    const i = args.indexOf("--channel");
    if (i !== -1 && args[i + 1]) ch = args[i + 1];
  }
  if (ch) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ch)) {
      console.log(c.yellow(`Ignoring invalid channel '${ch}'; keeping ${readChannel()}.`));
      ch = null;
    } else {
      writeChannel(ch);
    }
  }
  return ch || readChannel();
}
const packaged = fs.existsSync(path.join(repoRoot, "dist", "server.js"));
const serverEntry = path.join(repoRoot, packaged ? "dist/server.js" : "src/server.ts");
const nativePiEntry = path.join(repoRoot, packaged ? "dist/native-pi.js" : "src/native-pi.ts");
const bivyLoginEntry = path.join(repoRoot, packaged ? "dist/bivy-login.js" : "src/bivy-login.ts");
const credentialIngestEntry = path.join(repoRoot, packaged ? "dist/credential-ingest-cli.js" : "src/credential-ingest-cli.ts");
const automationEntry = path.join(repoRoot, packaged ? "dist/automation-cli.js" : "src/automation-cli.ts");
const configEntry = path.join(repoRoot, packaged ? "dist/config-cli.js" : "src/config-cli.ts");
const pluginEntry = path.join(repoRoot, packaged ? "dist/plugin-cli.js" : "src/plugin-cli.ts");
const relaySetupEntry = path.join(repoRoot, packaged ? "dist/relay-setup.js" : "src/relay-setup.ts");
// Dependency-free hosted-endpoint helper. Shipped to dist/ in the release
// artifact (src/ is not packaged), so resolve it the same packaged-aware way as
// the runtime entries and import it dynamically at call time.
const hostedEndpointsEntry = path.join(repoRoot, packaged ? "dist/hosted-endpoints.mjs" : "src/hosted-endpoints.mjs");
const githubConnectEntry = path.join(repoRoot, packaged ? "dist/github-connect-repo.js" : "src/github-connect-repo.ts");
const githubAppConnectEntry = path.join(repoRoot, packaged ? "dist/github-app-connect.js" : "src/github-app-connect.ts");
const githubAppSyncEntry = path.join(repoRoot, packaged ? "dist/github-app-sync-cli.js" : "src/github-app-sync-cli.ts");
const secretsEntry = path.join(repoRoot, packaged ? "dist/secrets-cli.js" : "src/secrets-cli.ts");
const sttEntry = path.join(repoRoot, packaged ? "dist/stt-cli.js" : "src/stt-cli.ts");
const attachEntry = path.join(repoRoot, packaged ? "dist/attach.js" : "src/attach.ts");
const relayAttachEntry = path.join(repoRoot, packaged ? "dist/relay-attach.js" : "src/relay-attach.ts");
const execEntry = path.join(repoRoot, packaged ? "dist/exec.js" : "src/exec.ts");
const mcpProxyEntry = path.join(repoRoot, packaged ? "dist/harness/mcp-proxy-cli.js" : "src/harness/mcp-proxy-cli.ts");
const mcpServeEntry = path.join(repoRoot, packaged ? "dist/harness/mcp-serve-cli.js" : "src/harness/mcp-serve-cli.ts");
const qrEntry = path.join(repoRoot, "public", "qr.js");
const tsxCli = packaged ? "" : path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const nodeBin = process.execPath;
const nodeScriptArgs = (entry) => (tsxCli ? [tsxCli, entry] : [entry]);

// Resolve the baked-in hosted endpoints (app/relay/client URLs). Imported lazily
// so the packaged-aware path above is only touched when setup actually needs it.
let _hostedEndpoints;
async function getHostedEndpoints() {
  if (!_hostedEndpoints) {
    ({ hostedEndpoints: _hostedEndpoints } = await import(pathToFileURL(hostedEndpointsEntry).href));
  }
  return _hostedEndpoints();
}

const SERVICE_LABEL = "dev.bivy";
const SERVICE_UNIT = "bivy.service";

function commandPath(extraPath = "") {
  const parts = [
    path.join(repoRoot, "bin"),
    path.join(os.homedir(), ".local", "bin"),
    extraPath,
    process.env.PATH || "",
  ].filter(Boolean);
  return [...new Set(parts.flatMap((part) => String(part).split(path.delimiter)).filter(Boolean))].join(path.delimiter);
}

process.env.PATH = commandPath();

// Keep redirected output and NO_COLOR consumers clean. FORCE_COLOR remains an
// explicit opt-in for demos/snapshots; otherwise ANSI belongs only on a TTY.
const colorEnabled = !Object.hasOwn(process.env, "NO_COLOR")
  && process.env.TERM !== "dumb"
  && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));
const color = (open, close) => (s) => colorEnabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s);
const c = {
  bold: color(1, 22),
  dim: color(2, 22),
  green: color(32, 39),
  yellow: color(33, 39),
  red: color(31, 39),
  cyan: color(36, 39),
};

// --- config -----------------------------------------------------------------

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(cliConfigPath, "utf8")); } catch { /* first run */ }
  const node = canonicalConfig?.node && typeof canonicalConfig.node === "object" ? canonicalConfig.node : {};
  const advanced = canonicalConfig?.environment && typeof canonicalConfig.environment === "object" ? canonicalConfig.environment : {};
  const agents = canonicalConfig?.agents && typeof canonicalConfig.agents === "object"
    ? { BIVY_CUSTOM_AGENTS: JSON.stringify(Object.entries(canonicalConfig.agents).map(([id, spec]) => ({ id, ...spec }))) }
    : {};
  return {
    workspace: typeof node.workspace === "string" ? node.workspace : typeof raw.workspace === "string" ? raw.workspace : repoRoot,
    port: Number(node.port) || Number(raw.port) || 4317,
    env: { ...(raw.env && typeof raw.env === "object" ? raw.env : {}), ...advanced, ...agents },
    service: raw.service === true,
  };
}

function saveConfig(config) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cliConfigPath, 0o600);
  } catch {
    // best effort
  }
}

// The daemon's agent-neutral settings file (<dataDir>/settings.json). Setup
// writes the chosen default agent here as well as cli.json's service environment:
// settings.json is authoritative on daemon boot, so updating only BIVY_RUNTIME
// would let an older Settings choice silently override the installer choice.
function loadSettings() {
  let raw = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appDir, "settings.json"), "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch { /* first run */ }
  const defaults = canonicalConfig?.defaults && typeof canonicalConfig.defaults === "object" ? canonicalConfig.defaults : {};
  const sessions = canonicalConfig?.sessions && typeof canonicalConfig.sessions === "object" ? canonicalConfig.sessions : {};
  const node = canonicalConfig?.node && typeof canonicalConfig.node === "object" ? canonicalConfig.node : {};
  const github = canonicalConfig?.github && typeof canonicalConfig.github === "object" ? canonicalConfig.github : {};
  return {
    ...raw,
    ...(defaults.agent ? { defaultAgent: defaults.agent } : {}),
    ...(Object.hasOwn(defaults, "model") ? { defaultModel: defaults.model } : {}),
    ...(defaults.sandbox ? { defaultSandbox: defaults.sandbox } : {}),
    ...(defaults.approval ? { approvalMode: defaults.approval } : {}),
    ...(node.maxConcurrentAutomations !== undefined ? { githubMaxConcurrent: node.maxConcurrentAutomations } : {}),
    ...(sessions.sync !== undefined ? { sessionSync: sessions.sync } : {}),
    ...(sessions.worktreeSync !== undefined ? { worktreeSync: sessions.worktreeSync } : {}),
    ...(sessions.standbyNodeId ? { syncStandbyNodeId: sessions.standbyNodeId } : {}),
    ...(sessions.resume ? { sessionResumeMode: sessions.resume } : {}),
    ...(sessions.autoAttachToolImages !== undefined ? { autoAttachToolImages: sessions.autoAttachToolImages } : {}),
    ...(github.issuePrompt ? { githubIssuePrompt: github.issuePrompt } : {}),
  };
}

function saveDefaultAgentSetting(runtimeId) {
  fs.mkdirSync(appDir, { recursive: true });
  const file = path.join(appDir, "settings.json");
  const settings = { ...loadSettings(), defaultAgent: String(runtimeId).trim().toLowerCase() };
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

// The default terminal agent when `bivy` / `bivy run` is invoked without an
// explicit agent. Pi is no longer privileged: it's only the last-resort fallback.
// Resolution mirrors the daemon: BIVY_RUNTIME env (process env, then the value
// persisted in cli.json) -> settings.defaultAgent -> "pi".
function resolveDefaultAgent() {
  const envRuntime = process.env.BIVY_RUNTIME || loadConfig().env?.BIVY_RUNTIME;
  if (envRuntime && String(envRuntime).trim()) return String(envRuntime).trim().toLowerCase();
  const fromSettings = loadSettings().defaultAgent;
  if (fromSettings && String(fromSettings).trim()) return String(fromSettings).trim().toLowerCase();
  return "pi";
}

function resolveSecretSync(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("secret://") && !raw.startsWith("env://") && !raw.startsWith("op://")) return value;
  if (raw.startsWith("env://")) return process.env[raw.slice("env://".length)] || "";
  if (raw.startsWith("op://")) {
    const res = spawnSync("op", ["read", raw], { encoding: "utf8", env: process.env });
    if (res.status !== 0) throw new Error(`Could not resolve 1Password secret ${raw}. Run 'op signin' and check the reference.`);
    return res.stdout.trim();
  }
  const id = raw.slice("secret://".length);
  const secretsFile = path.join(appDir, "secrets.json");
  const keyFile = path.join(appDir, "secrets.key");
  const data = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  const record = data.records?.[id];
  if (!record) throw new Error(`Secret ${id} is not configured. Run 'bivy secrets list'.`);
  if (record.backend === "env") return resolveSecretSync(record.ref || "");
  if (record.backend === "1password") return resolveSecretSync(record.ref || "");
  if (record.backend !== "local" || !record.iv || !record.tag || !record.ciphertext) throw new Error(`Secret ${id} has an unsupported backend.`);
  const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function resolveEnvSecrets(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) out[key] = resolveSecretSync(value);
  return out;
}

// True when a config value is a secret *reference* (resolved at runtime) rather
// than a raw inline secret we'd be storing in plaintext.
function isSecretRef(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("secret://") || raw.startsWith("env://") || raw.startsWith("op://");
}

// Store a plaintext secret in the encrypted local vault (`secrets.json` +
// `secrets.key`) and return its `secret://<id>` reference. Mirrors
// SecretVault.setLocal (AES-256-GCM) exactly — the same format resolveSecretSync
// above already decrypts — so the node, TUI and this CLI all resolve it the same
// way. Kept in the CLI (rather than shelling to the TS vault) so first-run setup
// never has to pass a token on argv.
function storeLocalSecretSync(id, plaintext, description) {
  const value = String(plaintext || "");
  if (!value) throw new Error("Secret value cannot be empty.");
  const secretsFile = path.join(appDir, "secrets.json");
  const keyFile = path.join(appDir, "secrets.key");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });

  // Load the 32-byte key, minting one only when the file genuinely doesn't exist.
  let key;
  try {
    key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`Local secrets key at ${keyFile} is invalid (expected 32 bytes)`);
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
    if (!error?.code && !/expected 32 bytes/.test(error?.message || "")) throw error;
    key = randomBytes(32);
    fs.writeFileSync(keyFile, `${key.toString("base64")}\n`, { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch { /* best effort */ }
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  let data = { version: 1, records: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
    if (parsed?.records && typeof parsed.records === "object") data = { version: 1, records: parsed.records };
  } catch { /* fresh vault */ }
  const at = new Date().toISOString();
  const prev = data.records[id];
  data.records[id] = {
    id,
    backend: "local",
    description: description ?? prev?.description,
    createdAt: prev?.createdAt ?? at,
    updatedAt: at,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  fs.writeFileSync(secretsFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(secretsFile, 0o600); } catch { /* best effort */ }
  return `secret://${id}`;
}

// Rewrite the installed service unit/plist in place (no enable/start) so a
// migrated `config.env` — e.g. BIVY_GITHUB_TOKEN now a `secret://` ref instead of
// a raw token — is reflected on disk immediately. Best-effort; the running
// service keeps its current env until its next restart.
function writeServiceUnitFileQuietly(config) {
  const { kind, file } = servicePaths();
  if (kind === "unsupported" || !fs.existsSync(file)) return;
  try {
    fs.writeFileSync(file, kind === "launchd" ? plistContent(config) : systemdContent(config));
    if (kind === "systemd") runQuiet("systemctl", ["--user", "daemon-reload"], { env: systemdUserEnv() });
  } catch { /* best effort */ }
}

// One-shot migration: if BIVY_GITHUB_TOKEN is a raw inline token (older installs
// stored it in plaintext in cli.json — and therefore in the systemd unit too),
// move it into the encrypted vault and replace it with a `secret://` reference.
// The server resolves the ref via resolveGitHubToken, so nothing else changes.
// Verifies the round-trip before dropping the plaintext, so a vault-write failure
// never loses GitHub access. Returns true when a migration happened.
function migrateGithubTokenToVault(config) {
  const raw = String(config?.env?.BIVY_GITHUB_TOKEN || "").trim();
  if (!raw || isSecretRef(raw)) return false;
  try {
    const ref = storeLocalSecretSync("github.repo-token", raw, "GitHub repo/work-queue token");
    if (resolveSecretSync(ref) !== raw) throw new Error("vault round-trip mismatch");
    config.env = { ...config.env, BIVY_GITHUB_TOKEN: ref };
    saveConfig(config);
    writeServiceUnitFileQuietly(config);
    return true;
  } catch (error) {
    if (process.env.BIVY_DEBUG) console.error(c.dim(`github token migration skipped: ${error?.message || String(error)}`));
    return false;
  }
}

function startEnv(config) {
  return {
    ...resolveEnvSecrets(config.env),
    ...process.env,
    PORT: String(process.env.PORT || config.port),
    BIVY_WORKSPACE: process.env.BIVY_WORKSPACE || config.workspace,
  };
}

function hasModelConfig(config) {
  return Boolean(
    config.env.ANTHROPIC_API_KEY ||
    config.env.OPENAI_API_KEY ||
    config.env.OPENROUTER_API_KEY ||
    // The shared, agent-neutral credential vault (moved from <dataDir>/pi to
    // <dataDir>/credentials). Its presence means a model credential was ingested.
    fs.existsSync(path.join(appDir, "credentials", "auth.enc")),
  );
}

const SETUP_AGENT_CHOICES = [
  { key: "p", label: "Pi (default, sign in to ChatGPT/Claude/Copilot or paste a model key)", runtimeId: "pi", needsBivyModel: true },
  { key: "c", label: "Claude Code", runtimeId: "claude-code-sdk", command: "claude", authProbe: ["auth", "status"], needsBivyModel: false, loginHint: "Sign in through Claude Code" },
  { key: "x", label: "Codex", runtimeId: "codex", command: "codex", authProbe: ["login", "status"], needsBivyModel: false, loginHint: "Sign in through Codex" },
  { key: "o", label: "OpenCode", runtimeId: "opencode", command: "opencode", needsBivyModel: false },
  { key: "g", label: "Gemini CLI", runtimeId: "gemini", command: "gemini", needsBivyModel: false, loginHint: "Sign in through Gemini" },
  { key: "q", label: "Qwen Code", runtimeId: "qwen", command: "qwen", needsBivyModel: false, loginHint: "Sign in through Qwen" },
  { key: "a", label: "Aider", runtimeId: "aider", needsBivyModel: true },
  { key: "l", label: "Cline", runtimeId: "cline", needsBivyModel: false },
  { key: "r", label: "Crush", runtimeId: "crush", needsBivyModel: false },
];

function setupAgentByRuntime(runtimeId) {
  return SETUP_AGENT_CHOICES.find((choice) => choice.runtimeId === runtimeId);
}

function setupAgentDefaultKey(config) {
  const saved = setupAgentByRuntime(String(config?.env?.BIVY_RUNTIME || ""));
  if (saved) return saved.key;
  const installed = SETUP_AGENT_CHOICES.find((choice) => choice.command && commandExists(choice.command));
  return installed?.key || "p";
}

function nativeAgentAuthDetected(choice) {
  if (!choice?.command || !commandExists(choice.command)) return false;
  if (Array.isArray(choice.authProbe)) {
    const result = runQuiet(choice.command, choice.authProbe, { timeout: 10_000 });
    if (result.code === 0) return true;
  }
  // Conservative file fallbacks for older CLI versions without a status command.
  if (choice.command === "codex") return fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
  if (choice.command === "claude") return fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"));
  return false;
}

async function ingestSetupAgentLogin(choice) {
  if (!choice || !["claude-code-sdk", "codex"].includes(choice.runtimeId)) return false;
  const code = await run(nodeBin, [
    ...nodeScriptArgs(credentialIngestEntry),
    choice.runtimeId,
    path.join(appDir, "credentials"),
    path.join(appDir, "pi"),
  ], { cwd: repoRoot, env: process.env, stdio: "ignore" });
  return code === 0;
}

function url(config) {
  return `http://localhost:${config.port}`;
}

// The host the node will bind (mirrors src/server.ts). We probe on this same
// address so a "free" port here is one the daemon can actually claim.
function nodeBindHost() {
  return process.env.BIVY_HOST ?? process.env.HOST ?? "127.0.0.1";
}

// --- process helpers --------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(c.red(`Failed to run ${cmd}: ${error.message}`));
      resolve(1);
    });
  });
}

/** Fixed executable + fixed entry point for setup's inline model-auth stage.
 * Keep this separate from the generic CLI forwarding helper: no user-provided
 * command or argv value reaches this process boundary. */
function runSetupModelLogin(config) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeScriptArgs(bivyLoginEntry), {
      stdio: "inherit",
      cwd: repoRoot,
      env: startEnv(config),
      shell: false,
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(c.red(`Failed to start model login: ${error.message}`));
      resolve(1);
    });
  });
}

function runQuiet(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] || "" : "";
}

function commandExists(cmd) {
  return runQuiet("sh", ["-lc", "command -v -- \"$1\" >/dev/null 2>&1", "sh", cmd]).code === 0;
}

function resolveCommand(cmd) {
  const found = runQuiet("sh", ["-lc", "command -v -- \"$1\"", "sh", cmd]);
  if (found.code === 0 && found.stdout.trim()) return found.stdout.trim().split("\n")[0];
  return "";
}

function npmGlobalBinCommand(cmd) {
  if (!commandExists("npm")) return "";
  const prefix = runQuiet("npm", ["prefix", "-g"]);
  if (prefix.code !== 0 || !prefix.stdout.trim()) return "";
  const executable = process.platform === "win32" ? `${cmd}.cmd` : cmd;
  const candidate = path.join(prefix.stdout.trim(), "bin", executable);
  return fs.existsSync(candidate) ? candidate : "";
}

function hasSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

async function ensureDeps() {
  if (!hasSupportedNode()) {
    console.error(c.red(`Node.js 22.19+ is required (found ${process.version}). Please upgrade and try again.`));
    return false;
  }
  const dependencyMarker = packaged
    ? path.join(repoRoot, "node_modules", "express", "package.json")
    : tsxCli;
  if (fs.existsSync(dependencyMarker)) return true;
  if (!commandExists("npm")) {
    console.error(c.red("npm is required (it ships with Node.js)."));
    return false;
  }
  if (process.platform === "linux" && (!commandExists("make") || !commandExists("g++") || !commandExists("python3"))) {
    console.error(c.red("Build tools are missing. On Ubuntu/Debian run: sudo apt-get update && sudo apt-get install -y build-essential python3"));
    return false;
  }
  const hasLockfile = fs.existsSync(path.join(repoRoot, "package-lock.json"));
  const args = hasLockfile ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  console.log(c.dim(`Installing dependencies (npm ${args.join(" ")})…`));
  const code = await run("npm", args, { cwd: repoRoot });
  if (code !== 0 || !fs.existsSync(dependencyMarker)) {
    console.error(c.red("npm install failed. Install Node.js 22.19+ and build tools (make/g++/python3), then try again."));
    return false;
  }
  return true;
}

function nodePackageInstalled(packageName) {
  return runQuiet(nodeBin, ["-e", "require.resolve(process.argv[1], { paths: [process.argv[2]] })", packageName, repoRoot]).code === 0;
}

async function ensureNodePackage(packageName) {
  if (nodePackageInstalled(packageName)) return true;
  if (!commandExists("npm")) {
    console.error(c.red(`npm is required to install ${packageName}.`));
    return false;
  }
  console.log(c.dim(`Installing ${packageName}…`));
  const code = await run("npm", ["install", packageName, "--no-audit", "--no-fund"], { cwd: repoRoot });
  return code === 0 && nodePackageInstalled(packageName);
}

const userLocalPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || path.join(os.homedir(), ".local");

async function ensureNpmCommand(command, packageName, label) {
  if (commandExists(command)) return true;
  if (!commandExists("npm")) {
    console.log(c.yellow(`Skipping ${label}: npm is not available.`));
    return false;
  }
  fs.mkdirSync(path.join(userLocalPrefix, "bin"), { recursive: true });
  console.log(c.dim(`Installing ${label} (${packageName})…`));
  const code = await run("npm", ["install", "--global", "--prefix", userLocalPrefix, packageName, "--no-audit", "--no-fund"]);
  return code === 0 && commandExists(command);
}

async function ensurePythonCommand(command, packageName, label) {
  if (commandExists(command)) return true;
  if (!commandExists("python3")) {
    console.log(c.yellow(`Skipping ${label}: python3 is not available.`));
    return false;
  }
  console.log(c.dim(`Installing ${label} (${packageName})…`));
  const code = await run("python3", ["-m", "pip", "install", "--user", packageName]);
  return code === 0 && commandExists(command);
}

// Single source of truth for what `bivy agents:install` installs, so its help
// text (see printHelp) can never drift from what it actually does (#113).
const BUNDLED_AGENTS = [
  { command: "claude", npmPackage: "@anthropic-ai/claude-code", label: "Claude Code" },
  { command: "codex", npmPackage: "@openai/codex", label: "Codex" },
  { command: "opencode", npmPackage: "opencode-ai/opencode", label: "OpenCode" },
  { command: "aider", pythonPackage: "aider-chat", label: "Aider" },
  { command: "hermes", npmPackage: "hermes", label: "Hermes" },
  { command: "gemini", npmPackage: "@google/gemini-cli", label: "Gemini CLI" },
];

async function ensureBundledAgents() {
  if (process.env.BIVY_SKIP_AGENT_PREINSTALL === "1") return true;
  console.log(c.dim("Ensuring bundled agent runtimes are installed…"));
  const results = [await ensureNodePackage("@anthropic-ai/claude-agent-sdk")];
  for (const agent of BUNDLED_AGENTS) {
    results.push(
      agent.pythonPackage
        ? await ensurePythonCommand(agent.command, agent.pythonPackage, agent.label)
        : await ensureNpmCommand(agent.command, agent.npmPackage, agent.label),
    );
  }
  const ok = results.every(Boolean);
  if (!ok) console.log(c.yellow("Some optional agent runtimes could not be installed. Bivy will still run; install them later from the Agents screen or re-run 'bivy agents:install'."));
  return ok;
}

async function ensureSetupAgent(choice) {
  if (!choice || choice.runtimeId === "pi") return true;
  if (choice.runtimeId === "claude-code-sdk") {
    const sdk = await ensureNodePackage("@anthropic-ai/claude-agent-sdk");
    const cli = await ensureNpmCommand("claude", "@anthropic-ai/claude-code", "Claude Code");
    return sdk && cli;
  }
  if (choice.runtimeId === "codex") return ensureNpmCommand("codex", "@openai/codex", "Codex");
  if (choice.runtimeId === "opencode") return ensureNpmCommand("opencode", "opencode-ai/opencode", "OpenCode");
  if (choice.runtimeId === "gemini") return ensureNpmCommand("gemini", "@google/gemini-cli", "Gemini CLI");
  if (choice.runtimeId === "qwen") return ensureNpmCommand("qwen", "@qwen-code/qwen-code", "Qwen Code");
  if (choice.runtimeId === "aider") return ensurePythonCommand("aider", "aider-chat", "Aider");
  if (choice.runtimeId === "cline") return ensureNpmCommand("cline", "cline", "Cline");
  if (choice.runtimeId === "crush") return ensureNpmCommand("crush", "@charmland/crush", "Crush");
  return true;
}

// The CLI-agent rows come from bin/agent-manifest.json — generated from
// CLI_AGENT_SPECS (`npm run gen:agent-manifest`), so the terminal `bivy run`
// agents never drift from the web picker's. A sync test guards the JSON. The two
// native rows (Pi, Claude Code) aren't CLI specs and stay defined here.
function loadAgentManifest() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "agent-manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return []; // shipped alongside this file; empty only in a broken checkout
  }
}

function loadPluginAgentManifest() {
  const root = process.env.BIVY_PLUGIN_DIR
    ? path.resolve(process.env.BIVY_PLUGIN_DIR)
    : path.join(appDir, "plugins");
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const seen = new Set();
  const reserved = new Set([
    "pi", "claude", "claude-code", "claude-code-sdk", "generic-cli", "codex-approvals",
    "openclaw", "bivy-agent-protocol", "acp", ...loadAgentManifest().map((agent) => agent.id),
  ]);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, "manifest.json"), "utf8"));
        if (manifest?.apiVersion !== "bivy.sh/v1alpha1" || manifest?.kind !== "Plugin" || manifest?.metadata?.id !== entry.name || !Array.isArray(manifest?.contributes?.agents)) return [];
        return manifest.contributes.agents.flatMap((agent) => {
          const id = typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "";
          const adapter = agent?.adapter;
          const command = typeof adapter?.command === "string" ? adapter.command.trim() : "";
          if (!/^[a-z][a-z0-9-]{1,47}$/.test(id) || reserved.has(id) || seen.has(id) || !command || !["process", "acp"].includes(adapter?.kind)) return [];
          seen.add(id);
          return [[id, {
            label: typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : id,
            type: "command",
            command,
            args: [],
            plugin: entry.name,
            headlessFlags: adapter.kind === "process" && Array.isArray(adapter.args)
              ? adapter.args.filter((arg) => typeof arg === "string")
              : [],
          }]];
        });
      } catch {
        return [];
      }
    });
}

function loadCustomAgentManifest() {
  const raw = process.env.BIVY_CUSTOM_AGENTS || loadConfig().env?.BIVY_CUSTOM_AGENTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    const reserved = new Set(["pi", "claude", "claude-code", "claude-code-sdk", "generic-cli", "codex-approvals", "openclaw", "bivy-agent-protocol", "acp", ...loadAgentManifest().map((agent) => agent.id)]);
    return parsed.flatMap((item) => {
      const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
      const base = loadAgentManifest().find((agent) => agent.id === item?.extends);
      const command = typeof item?.command === "string" && item.command.trim() ? item.command.trim() : base?.command;
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(id) || reserved.has(id) || !command) return [];
      return [[id, {
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : id,
        type: "command",
        command,
        args: Array.isArray(item.args) && item.args.every((a) => typeof a === "string") ? item.args : [],
      }]];
    });
  } catch {
    return [];
  }
}

// Headless "one-shot" tokens for an agent, derived from the manifest — the
// fallback for any spec that isn't hand-tuned in AGENT_HEADLESS_FLAGS below, so a
// newly-added agent still gets one-shot detection with no edit here.
function manifestHeadlessFlags(id) {
  const entry = loadAgentManifest().find((a) => a.id === id);
  if (entry?.headlessFlags?.length) return entry.headlessFlags;
  const plugin = loadPluginAgentManifest().find(([pluginId]) => pluginId === id)?.[1];
  return plugin?.headlessFlags?.length ? plugin.headlessFlags : undefined;
}

const BUILTIN_TERMINAL_AGENTS = new Map([
  ["pi", { label: "Pi", type: "native-pi" }],
  ["claude", { label: "Claude Code", type: "command", command: "claude", npmPackage: "@anthropic-ai/claude-code" }],
  ["openclaw", { label: "OpenClaw", type: "command", command: process.env.BIVY_OPENCLAW_COMMAND || "openclaw" }],
  ...loadAgentManifest().map((a) => [
    a.id,
    {
      label: a.label,
      type: "command",
      // The manifest carries each agent's real binary (e.g. Rovo Dev → `acli`,
      // Continue → `cn`, Kilo Code → `kilo`).
      command: a.command,
      // Auto-install only from npm; curl/pip agents resolve if already on PATH.
      ...(a.install?.kind === "npm" ? { npmPackage: a.install.pkg } : {}),
    },
  ]),
  ...loadPluginAgentManifest(),
  ...loadCustomAgentManifest(),
]);

async function ensureTerminalCommand(agent) {
  let command = resolveCommand(agent.command) || npmGlobalBinCommand(agent.command) || agent.command;
  if (commandExists(agent.command) || fs.existsSync(command)) return command;

  if (!agent.npmPackage) return "";
  if (!commandExists("npm")) {
    console.error(c.red(`npm is required to install ${agent.label}.`));
    return "";
  }

  console.log(c.dim(`${agent.label} command not found; installing ${agent.npmPackage}…`));
  fs.mkdirSync(path.join(userLocalPrefix, "bin"), { recursive: true });
  const code = await run("npm", ["install", "--global", "--prefix", userLocalPrefix, agent.npmPackage, "--no-audit", "--no-fund"]);
  if (code !== 0) return "";

  command = resolveCommand(agent.command) || npmGlobalBinCommand(agent.command) || agent.command;
  return commandExists(agent.command) || fs.existsSync(command) ? command : "";
}

function customTerminalAgent(agentId) {
  const key = agentId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const command = process.env[`BIVY_AGENT_${key}_COMMAND`]?.trim();
  if (!command) return undefined;
  let args = [];
  const rawArgs = process.env[`BIVY_AGENT_${key}_ARGS`]?.trim();
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (Array.isArray(parsed)) args = parsed.map(String);
      else throw new Error("not an array");
    } catch {
      throw new Error(`BIVY_AGENT_${key}_ARGS must be a JSON array, e.g. '["--flag"]'.`);
    }
  }
  return { label: agentId, type: "command", command, args };
}

function terminalAgent(agentId) {
  const id = (agentId || resolveDefaultAgent()).toLowerCase();
  return { id, agent: BUILTIN_TERMINAL_AGENTS.get(id) ?? customTerminalAgent(id) };
}

async function waitForNode(config, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReachable(config)) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function ensureNodeRunning(config) {
  // One-shot: harden a legacy plaintext GitHub token into the vault before the
  // node (re)starts. Operates on a fresh on-disk config so a caller's transient
  // merged env is never persisted; idempotent once migrated.
  migrateGithubTokenToVault(loadConfig());
  if (await isReachable(config)) return true;

  if (restartService()) {
    console.log(c.dim("Starting Bivy node service…"));
    if (await waitForNode(config, 12000)) return true;
    printNodeStartupDiagnostics();
    return false;
  }

  console.log(c.dim("Starting Bivy node in the background…"));
  // Capture stdout/stderr to a log so a crash on startup is diagnosable instead
  // of vanishing into stdio: "ignore". Best effort — fall back to ignoring
  // output if the log can't be opened.
  let logFd;
  try {
    fs.mkdirSync(appDir, { recursive: true });
    logFd = fs.openSync(nodeLogPath, "w");
  } catch {
    logFd = undefined;
  }
  const child = spawn(nodeBin, nodeScriptArgs(serverEntry), {
    cwd: repoRoot,
    env: startEnv(config),
    detached: true,
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
  });
  child.unref();
  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch {}
  }
  if (await waitForNode(config, 12000)) return true;
  printNodeStartupDiagnostics();
  return false;
}

// Resolve an agent id (or a raw `-- command…`) to a spec the node can spawn as a
// run-terminal: { agent, label, command, args }. Installs the agent binary if we
// know its package (via ensureTerminalCommand). Returns null if it can't be found.
async function resolveRunSpec(agentId, extraArgs) {
  if (agentId === "--") {
    const [command, ...args] = extraArgs;
    if (!command) return { error: "Usage: bivy run -- <command> [args…]" };
    return { spec: { agent: path.basename(command), label: path.basename(command), command, args } };
  }
  const { id, agent } = terminalAgent(agentId);
  if (!agent) {
    return { error: `Unknown agent: ${agentId}. Built-ins: ${[...BUILTIN_TERMINAL_AGENTS.keys()].join(", ")}. Or: bivy run -- <command>.` };
  }
  if (agent.type === "native-pi") {
    return { spec: { agent: id, label: agent.label, command: nodeBin, args: [...nodeScriptArgs(nativePiEntry), ...extraArgs] } };
  }
  const command = await ensureTerminalCommand(agent);
  if (!command) {
    return { error: `${agent.label} command not found: ${agent.command}. Install it or use 'bivy run pi'.` };
  }
  return { spec: { agent: id, label: agent.label, command, args: [...(agent.args ?? []), ...extraArgs] } };
}

// Pull bivy's own `--name`/`--model` flags (space or `=` form) out of the run
// args so they aren't blindly forwarded. Only honored before a `--` separator,
// past which everything is the raw command the user asked to run.
// Does a token look like a git remote (URL, scp-style, owner/repo, or a path)
// rather than an agent id? Lets `--clone <remote>` disambiguate from bare
// `--clone` (= current folder's repo) without a required `=`.
function looksLikeRemote(value) {
  const v = String(value || "");
  return /:\/\//.test(v) || /@[^/]+:/.test(v) || /\.git$/.test(v) || v.startsWith("/") || v.startsWith(".") || /^[\w.-]+\/[\w.-]+$/.test(v);
}

function extractRunFlags(args) {
  const rest = [];
  let name, model, node, workspace;
  let clone; // undefined = no clone; true = current repo; string = explicit remote
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { rest.push(...args.slice(i)); break; }
    if (a === "--name" && args[i + 1] !== undefined) { name = args[++i]; continue; }
    if (a.startsWith("--name=")) { name = a.slice("--name=".length); continue; }
    if (a === "--model" && args[i + 1] !== undefined) { model = args[++i]; continue; }
    if (a.startsWith("--model=")) { model = a.slice("--model=".length); continue; }
    if (a === "--node" && args[i + 1] !== undefined) { node = args[++i]; continue; }
    if (a.startsWith("--node=")) { node = a.slice("--node=".length); continue; }
    if (a === "--workspace" && args[i + 1] !== undefined) { workspace = args[++i]; continue; }
    if (a.startsWith("--workspace=")) { workspace = a.slice("--workspace=".length); continue; }
    if (a.startsWith("--clone=")) { clone = a.slice("--clone=".length); continue; }
    if (a === "--clone") { clone = looksLikeRemote(args[i + 1]) ? args[++i] : true; continue; }
    rest.push(a);
  }
  return { name: name?.trim() || undefined, model: model?.trim() || undefined, node: node?.trim() || undefined, workspace: workspace?.trim() || undefined, clone, rest };
}

// A safe-ish workspace dir name from a remote or path (basename minus .git).
function deriveRepoName(remote) {
  const base = String(remote).replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() || "repo";
  return base.replace(/[^\w.-]+/g, "-").slice(0, 40) || "repo";
}

// Resolve the workspace directory for a new session. `--workspace <dir>` uses an
// existing directory; `--clone` makes a fresh checkout under .bivy/workspaces:
// bare `--clone` clones the current folder's repo (its origin remote, or the
// local checkout when there's no remote), `--clone <remote>` clones that remote.
// Returns undefined when neither option was given (use the node's default).
function resolveWorkspaceDir({ clone, workspace }) {
  if (workspace) {
    const dir = path.resolve(workspace);
    if (!fs.existsSync(dir)) throw new Error(`Workspace does not exist: ${dir}`);
    if (!fs.statSync(dir).isDirectory()) throw new Error(`Workspace is not a directory: ${dir}`);
    return dir;
  }
  if (clone === undefined) return undefined;

  let remote = typeof clone === "string" ? clone.trim() : "";
  if (!remote) {
    const origin = runQuiet("git", ["-C", process.cwd(), "remote", "get-url", "origin"]).stdout.trim();
    if (origin) remote = origin;
    else {
      const top = runQuiet("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"]).stdout.trim();
      if (!top) throw new Error("Not inside a git repository. Use 'bivy run <agent> --clone <remote>' to clone a specific repo.");
      remote = top; // clone the local checkout by path
    }
  }
  if (!commandExists("git")) throw new Error("git is required for --clone but was not found on PATH.");

  const root = path.join(appDir, "workspaces");
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, `${deriveRepoName(remote)}-${randomBytes(3).toString("hex")}`);
  console.log(c.dim(`Cloning ${remote} → ${dest}…`));
  const res = runQuiet("git", ["clone", remote, dest]);
  if (res.code !== 0) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    throw new Error(`git clone failed: ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join("\n")}`);
  }
  return dest;
}

// Where a `bivy run` with neither --workspace nor --clone should start.
//
// The PTY is spawned by the daemon, not by this process, so it has no idea where
// you typed the command. Without this, running an agent from your checkout would
// silently root it in the node's configured workspace: a relative command
// (`bivy run -- ./my-agent`) fails to resolve, and — worse — a relative argument
// (`--repo .`) resolves to the wrong repo and the agent happily does the wrong
// work. Adopting the cwd makes the common case ("run an agent on the repo I'm
// standing in") correct by default.
//
// Only when the cwd is inside a git work tree: a bare `bivy` from $HOME or /tmp
// should still land in the configured workspace rather than turning an agent
// loose on the home directory. Uses the cwd itself, not the repo root, to match
// `--workspace .` and to respect an intentional `cd` into a monorepo package.
function defaultRunWorkspace(config) {
  const fallback = config.workspace || repoRoot;
  const cwd = process.cwd();
  const res = runQuiet("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout.trim() === "true" ? cwd : fallback;
}

// --- nodes registry ---------------------------------------------------------
// Other Bivy nodes this machine can reach directly (LAN, Tailscale, SSH tunnel,
// VPN). name → { url, token }. `bivy run --node <name>` starts the session on
// that node instead of the local one; the PTY lives there, so `bivy resume` from
// the remote node (or a phone/web app) can rejoin it.

const nodesConfigPath = path.join(appDir, "nodes.json");

function loadNodes() {
  try {
    const data = JSON.parse(fs.readFileSync(nodesConfigPath, "utf8"));
    return data && typeof data.nodes === "object" ? data : { version: 1, nodes: {} };
  } catch {
    return { version: 1, nodes: {} };
  }
}

function saveNodes(data) {
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  const tmp = `${nodesConfigPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, nodesConfigPath);
}

// --- agent shims ------------------------------------------------------------
// A shim shadows an agent binary (e.g. `claude`) on PATH so that starting the
// agent from a terminal transparently launches it inside a Bivy-owned PTY (via
// `bivy run <agent>`) instead of a bare process. Locally you still get the
// agent's native TUI; because the daemon owns the PTY, the same live session is
// visible and drivable from the remote web/PWA ("continue on CLI"), and the
// session id is pinned at launch so it can later be resumed as a governed chat.
// Headless invocations (non-TTY stdin, or a one-shot flag like `claude -p`) pass
// straight through to the real binary, so scripts, pipes, CI, and the agent
// subprocess a managed resume itself spawns are never intercepted (that same
// passthrough is the recursion guard). The mechanism is agent-agnostic: the
// per-agent knowledge is just a small list of "this call is headless" flags and,
// optionally, the flag used to pin a session id.

const shimsConfigPath = path.join(appDir, "shims.json");

// Line that marks a file as a Bivy-generated shim. Uninstall refuses to delete
// any file that lacks it, so a shim can never clobber a user's real binary.
const SHIM_MARKER = "# bivy-shim v1 — managed by `bivy shim`; do not edit";

// Per-agent tokens that mean "this invocation is one-shot / headless" and should
// bypass Bivy and run the real agent directly. Non-TTY stdin is always treated
// as headless regardless of this list, so the list only needs to catch a human
// running a one-shot in their terminal. Unknown agents fall back to DEFAULT.
const AGENT_HEADLESS_FLAGS = {
  default: ["-p", "--print"],
  claude: ["-p", "--print"],
  codex: ["exec", "--json"],
  gemini: ["-p", "--prompt"],
  qwen: ["-p", "--prompt"],
  aider: ["--message", "--msg"],
  goose: ["run"],
  opencode: ["run"],
  crush: ["run"],
  cline: ["-y", "--yolo", "--no-interactive", "--json"],
  cursor: ["-p", "--print"],
  copilot: ["-p", "--prompt"],
  grok: ["-p", "--prompt"],
  amp: ["-x", "--execute"],
  auggie: ["-p", "--print"],
  droid: ["exec"],
  continue: ["-p"],
  kilocode: ["run"],
  rovodev: ["run"],
  codebuff: ["-p", "--print"],
};

// Flag an agent's CLI accepts to pin a specific session id at launch, so the
// daemon knows the resume target up front (no transcript-file guessing) and can
// later resume the session as a governed chat. Only agents whose CLI supports it
// appear here; others simply run without a pinned id.
const AGENT_SESSION_ID_FLAG = {
  claude: "--session-id", // `claude --session-id <uuid>` (must be a valid UUID)
  // Official Grok CLI: `grok --session-id <uuid>` pins a new session UUID under
  // ~/.grok/sessions/<cwd>/<uuid>/ so takeover / resume has a known target.
  grok: "--session-id",
};

// Args that mean the caller already chose a session (pin or resume), so we must
// not inject our own --session-id over the top.
const SESSION_ID_CONFLICTS = ["--session-id", "--resume", "-r", "-c", "--continue"];

// How each agent's native CLI resumes a saved session by id. `bivy resume`/`bivy
// sessions` reopen a durable session by relaunching it through `bivy run` with
// these args — i.e. the agent's own resume, in a Bivy-managed, relay-visible
// PTY. Agents without a known form fall back to `--resume <id>` (the convention
// most CLIs follow, and the hint `bivy run` already prints when pinning an id).
const AGENT_RESUME_ARGS = {
  claude: (id) => ["--resume", id],
  codex: (id) => ["resume", id],
  grok: (id) => ["--resume", id],
};
function agentResumeArgs(agentId, sessionRef) {
  const fn = AGENT_RESUME_ARGS[(agentId || "").toLowerCase()];
  return fn ? fn(sessionRef) : ["--resume", sessionRef];
}

// If the agent supports id pinning and the caller didn't already pick a session,
// generate a UUID, prepend the agent's pin flag, and record it on the spec.
// Returns the pinned id (or undefined).
function pinRunSessionId(agentId, spec) {
  const flag = AGENT_SESSION_ID_FLAG[agentId];
  if (!flag) return undefined;
  const args = spec.args ?? [];
  const alreadyChosen = args.some((a) => SESSION_ID_CONFLICTS.includes(a) || SESSION_ID_CONFLICTS.some((f) => a.startsWith(`${f}=`)));
  if (alreadyChosen) return undefined;
  const id = randomUUID();
  spec.args = [flag, id, ...args];
  spec.sessionId = id;
  return id;
}

function loadShims() {
  try {
    const data = JSON.parse(fs.readFileSync(shimsConfigPath, "utf8"));
    return data && typeof data.shims === "object" ? data : { version: 1, shims: {} };
  } catch {
    return { version: 1, shims: {} };
  }
}

function saveShims(data) {
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  const tmp = `${shimsConfigPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, shimsConfigPath);
}

// Directory the shim is installed into. Defaults to the same `~/.local/bin` that
// npm-installed agent CLIs land in; overridable so it can be placed ahead of a
// system binary on PATH.
function defaultShimDir() {
  return path.join(userLocalPrefix, "bin");
}

// Resolve the REAL agent binary while ignoring `excludeDir` (the shim's own dir),
// so we never resolve the shim itself. Returns "" when nothing else on PATH
// provides the command.
function resolveRealBinary(agentCmd, excludeDir) {
  const cleaned = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(excludeDir))
    .join(path.delimiter);
  // Plain `-c` (not `-lc`): PATH is set explicitly here, and a login shell would
  // source profiles that can print noise onto stdout.
  const found = runQuiet("sh", ["-c", 'PATH="$1" command -v -- "$2" 2>/dev/null', "sh", cleaned, agentCmd]);
  const line = found.code === 0 ? found.stdout.trim().split("\n").pop() : "";
  return line && line.startsWith("/") ? line : "";
}

// Resolve what a command name currently points to on the full PATH (no login
// shell, so no profile noise). Used to check whether an installed shim actually
// wins on PATH. Returns "" when unresolved or resolved to a non-path (builtin).
function whichOnPath(cmd) {
  const found = runQuiet("sh", ["-c", 'command -v -- "$1" 2>/dev/null', "sh", cmd]);
  const line = found.code === 0 ? found.stdout.trim().split("\n").pop() : "";
  return line && line.startsWith("/") ? line : "";
}

// The POSIX-sh shim body. Everything agent-specific is injected as data, so the
// script itself is identical across agents.
function renderShim({ agent, agentCmd, shimDir, realFallback, headlessFlags }) {
  const shq = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh
${SHIM_MARKER}
# Launches an interactive '${agent}' as its native TUI inside a Bivy PTY (via
# 'bivy run'); passes headless invocations straight through to the real binary.
AGENT=${shq(agent)}
AGENT_CMD=${shq(agentCmd)}
SHIM_DIR=${shq(shimDir)}
REAL_FALLBACK=${shq(realFallback)}
HEADLESS_FLAGS=${shq(headlessFlags.join(" "))}
BIVY_NODE=${shq(nodeBin)}
BIVY_SCRIPT=${shq(selfScript)}

# Rebuild PATH without our own directory: used both to find the real binary and
# to run the session's children, so nothing re-enters this shim.
clean_path=""
oldifs=$IFS
IFS=:
for p in $PATH; do
  [ "$p" = "$SHIM_DIR" ] && continue
  clean_path="\${clean_path:+$clean_path:}$p"
done
IFS=$oldifs

REAL=$(PATH="$clean_path" command -v -- "$AGENT_CMD" 2>/dev/null || true)
[ -n "$REAL" ] || REAL="$REAL_FALLBACK"

# Decide headless vs interactive.
headless=0
[ -t 0 ] || headless=1
if [ "$headless" -eq 0 ]; then
  for a in "$@"; do
    for f in $HEADLESS_FLAGS; do
      [ "$a" = "$f" ] && { headless=1; break; }
    done
    [ "$headless" -eq 1 ] && break
  done
fi

# Escape hatch: BIVY_SHIM_DISABLE=1 (all) or =<agent> forces the real binary.
case "\${BIVY_SHIM_DISABLE:-}" in
  1|"$AGENT") headless=1 ;;
esac

if [ "$headless" -eq 1 ]; then
  if [ -z "$REAL" ]; then
    echo "bivy-shim: could not find the real '$AGENT_CMD' on PATH (excluding $SHIM_DIR)." >&2
    exit 127
  fi
  exec "$REAL" "$@"
fi

# Interactive: launch the agent's native TUI inside a Bivy-owned PTY (via
# 'bivy run'), so the same live session is drivable from the remote web/PWA and
# the session id is pinned for later resume-as-chat. PATH is cleaned so the agent
# process Bivy spawns resolves the real binary, not this shim.
exec env PATH="$clean_path" "$BIVY_NODE" "$BIVY_SCRIPT" run "$AGENT" "$@"
`;
}

// Render a path with $HOME abbreviated to `~` for display.
function tildify(p) {
  const home = os.homedir();
  const resolved = path.resolve(p);
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) return `~${resolved.slice(home.length)}`;
  return resolved;
}

// Distinct directories that currently hold Bivy shims (from shims.json).
function installedShimDirs() {
  const dirs = new Set();
  const data = loadShims();
  for (const key of Object.keys(data.shims)) {
    const dir = data.shims[key]?.dir;
    if (dir) dirs.add(path.resolve(dir));
  }
  return [...dirs];
}

// Idempotently reconcile the managed PATH block in the user's shell rc so that
// every installed shim dir wins over version-manager bins. Rebuilds the block
// from the current shims.json each call; removes it entirely once no shims
// remain. Returns { ok, file?, changed, present, reason? }.
function syncManagedPathBlock() {
  const target = rcFileForShell(process.env.SHELL, os.homedir());
  if (!target) return { ok: false, changed: false, present: false, reason: "unknown-shell" };
  const dirs = installedShimDirs();
  let content = "";
  let mode = 0o644;
  try {
    content = fs.readFileSync(target.file, "utf8");
    mode = fs.statSync(target.file).mode & 0o777;
  } catch {
    // rc file doesn't exist yet — we'll create it.
  }
  const next = dirs.length === 0
    ? removeManagedBlock(content)
    : upsertManagedBlock(content, renderManagedBlock(dirs));
  if (next === content) {
    return { ok: true, file: target.file, changed: false, present: dirs.length > 0 };
  }
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  const tmp = `${target.file}.bivy-tmp`;
  fs.writeFileSync(tmp, next, { mode });
  fs.renameSync(tmp, target.file);
  return { ok: true, file: target.file, changed: true, present: dirs.length > 0 };
}

// Resolve what `cmd` points to in a fresh *interactive* login shell — i.e. after
// the user's rc (and its version-manager hooks) have run. This is what the shim
// actually competes with, unlike `whichOnPath`, which sees this process's PATH
// (doctored at startup to front-load ~/.local/bin, so it would falsely report
// "active"). Best-effort: returns "" if the shell can't be run, times out, or
// resolves to a non-path builtin.
function resolveViaLoginShell(cmd) {
  const shell = process.env.SHELL;
  if (!shell || process.platform === "win32") return "";
  const res = runQuiet(shell, ["-ic", 'command -v -- "$1" 2>/dev/null', shell, cmd], {
    timeout: 5000,
    input: "",
  });
  // `-i` may print prompt/rc noise; take the last absolute-path line (our
  // `command -v` runs last).
  const line = (res.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  return line.startsWith("/") ? line : "";
}

// Where does `agent` actually resolve for the user? Prefer a real interactive
// shell (reflects the rc + version managers); fall back to this process's PATH.
function activeAgentPath(agent) {
  return resolveViaLoginShell(agent) || whichOnPath(agent);
}

async function isUrlReachable(baseUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

// Resolve a `--node <name>` target to a reachable { url, token }. Direct registry
// entries win; if the name is only known to the account's control plane we can
// name it and report online status, but relaying the PTY through the hosted
// control plane is a larger follow-up, so we point the user at a direct route.
async function resolveNodeTarget(nodeName) {
  const registry = loadNodes().nodes;
  const direct = registry[nodeName];
  if (direct?.url) {
    return { url: String(direct.url).replace(/\/+$/, ""), token: direct.token, source: "direct" };
  }

  const relay = loadRelayConfig();
  if (relay?.controlPlaneUrl && relay?.enrollmentToken) {
    try {
      const data = await controlPlaneNodeApi(relay, "/nodes");
      const list = Array.isArray(data) ? data : (data?.nodes || []);
      const match = list.find((n) => n.name === nodeName || n.id === nodeName);
      if (match) {
        // Account node with no direct route: tunnel to it through the relay,
        // exactly as a phone does. resolveNodeTarget stays synchronous about the
        // decision; the relay-attach bridge performs the actual pairing.
        if (!match.online) {
          throw new Error(`Node "${nodeName}" is registered to your account but is currently offline.`);
        }
        return { source: "relay", nodeId: match.id, name: match.name || nodeName };
      }
    } catch (error) {
      // A concrete "offline" decision is actionable — surface it. Any other
      // control-plane failure (lookup unreachable) falls through to the generic
      // "unknown node" error below.
      if (error instanceof Error && /is currently offline/.test(error.message)) throw error;
    }
  }

  const known = Object.keys(registry);
  throw new Error(
    `Unknown node "${nodeName}".` +
    (known.length ? ` Registered nodes: ${known.join(", ")}.` : ` Add one with 'bivy nodes add <name> <url> --token <token>'.`),
  );
}

// `bivy nodes` — list registered direct nodes (and, when relay is configured,
// the account's control-plane nodes). `add`/`remove` manage the direct registry.
async function cmdNodes(args = []) {
  const [sub, ...rest] = args;

  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy nodes [list] | bivy nodes add <name> <url> [--token <token>] | bivy nodes remove <name>\n\nList directly-registered nodes plus (when relay is configured) your account's control-plane nodes, and add/remove direct routes. Run a session on any of them with 'bivy run --node <name>' — direct nodes connect straight to their URL, account nodes tunnel through the relay.");
    return;
  }

  if (sub && sub !== "list" && sub !== "ls" && sub !== "add" && sub !== "remove" && sub !== "rm") {
    console.error(c.red(`Unknown nodes subcommand: ${sub}. Usage: bivy nodes [list|add|remove]`));
    process.exit(1);
    return;
  }

  if (sub === "add") {
    const name = rest[0];
    const nodeUrl = rest[1];
    if (!name || !nodeUrl) {
      console.error(c.red("Usage: bivy nodes add <name> <url> [--token <token>]"));
      process.exit(1);
      return;
    }
    const token = argValue(rest, "token") || undefined;
    const data = loadNodes();
    data.nodes[name] = { url: String(nodeUrl).replace(/\/+$/, ""), token, addedAt: new Date().toISOString() };
    saveNodes(data);
    const reachable = await isUrlReachable(data.nodes[name].url);
    console.log(c.green(`Added node "${name}" → ${data.nodes[name].url} ${reachable ? c.green("● reachable") : c.dim("○ not reachable right now")}`));
    if (!token) console.log(c.dim("No token stored. If the node requires auth, run 'bivy token' on it and re-add with --token."));
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = rest[0];
    const data = loadNodes();
    if (!name || !data.nodes[name]) { console.error(c.red(`No registered node "${name}".`)); process.exit(1); return; }
    delete data.nodes[name];
    saveNodes(data);
    console.log(c.green(`Removed node "${name}".`));
    return;
  }

  // list
  const registry = loadNodes().nodes;
  const names = Object.keys(registry);
  console.log(c.bold("\n  Direct nodes") + c.dim("  (bivy run --node <name>)\n"));
  if (names.length === 0) {
    console.log(c.dim("  none — add one with 'bivy nodes add <name> <url> --token <token>'"));
  } else {
    const reach = await Promise.all(names.map((n) => isUrlReachable(registry[n].url)));
    names.forEach((n, i) => {
      console.log(`  ${c.cyan(n.padEnd(14))} ${registry[n].url}  ${reach[i] ? c.green("● reachable") : c.dim("○ offline")}${registry[n].token ? "" : c.dim("  (no token)")}`);
    });
  }

  const relay = loadRelayConfig();
  if (relay?.controlPlaneUrl && relay?.enrollmentToken) {
    try {
      const data = await controlPlaneNodeApi(relay, "/nodes");
      const cpNodes = Array.isArray(data) ? data : (data?.nodes || []);
      console.log(c.bold("\n  Account nodes") + c.dim("  (from the control plane — run on any online one with 'bivy run --node <name>')\n"));
      if (cpNodes.length === 0) console.log(c.dim("  none registered"));
      else for (const n of cpNodes) {
        const route = names.includes(n.name)
          ? c.dim("  [direct route configured]")
          : (n.online ? c.dim("  reachable over the relay") : "");
        console.log(`  ${c.cyan(String(n.name).padEnd(14))} ${n.online ? c.green("● online") : c.dim("○ offline")}${route}`);
      }
    } catch {
      console.log(c.dim("\n  (could not reach the control plane to list account nodes)"));
    }
  }
  console.log("");
}

// `bivy agents` — list the agents Bivy can launch (its built-in terminal agents),
// showing which are installed on PATH. `bivy run <agent>` starts one; the bundled
// ones are installed with `bivy agents:install`. `--json` for machine-readable output.
function cmdAgents(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy agents [--json]\n\nList the agents Bivy can launch ('bivy run <agent>') and which are installed on PATH. 'bivy agents:install' installs the bundled ones.");
    return;
  }
  const asJson = args.includes("--json");
  const rows = [...BUILTIN_TERMINAL_AGENTS.entries()].map(([id, meta]) => {
    if (meta.type === "native-pi") {
      return { id, label: meta.label, type: meta.type, command: null, installed: true, path: null };
    }
    const command = meta.command || id;
    const resolved = whichOnPath(command);
    return { id, label: meta.label, type: meta.type, command, installed: Boolean(resolved), path: resolved || null, ...(meta.plugin ? { plugin: meta.plugin } : {}) };
  });

  if (asJson) {
    console.log(JSON.stringify({ agents: rows }, null, 2));
    return;
  }

  console.log(c.bold("\n  Agents") + c.dim("  (bivy run <agent> — 'bivy agents:install' adds the bundled ones)\n"));
  for (const row of rows) {
    const status = row.type === "native-pi"
      ? c.green("● built-in")
      : row.installed ? c.green("● installed") : c.dim("○ not installed");
    const where = row.path ? c.dim(`  ${row.path}`) : "";
    const source = row.plugin ? c.dim(`  plugin:${row.plugin}`) : "";
    console.log(`  ${c.cyan(row.id.padEnd(12))} ${String(row.label).padEnd(16)} ${status}${source}${where}`);
  }
  console.log("");
}

// `bivy token` — mint and print a device token for THIS node. Copy it to another
// machine and `bivy nodes add <name> <this-url> --token <token>` to let it run
// sessions here over a direct/tunnelled connection.
async function cmdToken(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy token\n\nMint and print a device token for this node. Copy it to another machine and run 'bivy nodes add <name> <this-url> --token <token>' there.");
    return;
  }
  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) {
    console.error(c.red(`Could not start the Bivy node at ${url(config)}.`));
    process.exit(1);
    return;
  }
  try {
    const token = await localDeviceToken(config);
    console.log(token);
  } catch (error) {
    console.error(c.red(error?.message || String(error)));
    process.exit(1);
  }
}

// `bivy shim install|uninstall|status <agent>` — shadow an agent binary so that
// starting it interactively launches the native TUI inside a Bivy PTY. See
// the "agent shims" helpers above for the mechanism.
async function cmdShim(args = []) {
  const [sub, ...rest] = args;

  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy shim [status] | bivy shim install <agent> [--dir <dir>] [--headless \"<flags>\"] [--force] | bivy shim uninstall <agent>\n\nMake an interactive agent binary launch its native TUI in a Bivy PTY (remote-visible; resumable as chat).");
    return;
  }

  if (sub && sub !== "status" && sub !== "list" && sub !== "install" && sub !== "add" && sub !== "uninstall" && sub !== "remove" && sub !== "rm") {
    console.error(c.red(`Unknown shim subcommand: ${sub}. Usage: bivy shim install|uninstall|status <agent>`));
    process.exit(1);
    return;
  }

  if (sub === "install" || sub === "add") {
    const agent = rest.find((a) => !a.startsWith("-"));
    if (!agent) {
      console.error(c.red("Usage: bivy shim install <agent> [--dir <dir>] [--headless \"<flags>\"] [--force]"));
      process.exit(1);
      return;
    }
    const builtin = BUILTIN_TERMINAL_AGENTS.get(agent);
    if (builtin && builtin.type === "native-pi") {
      console.error(c.red(`"${agent}" is Bivy's own native runtime, not a standalone binary — nothing to shim. Just run 'bivy -a ${agent}'.`));
      process.exit(1);
      return;
    }
    const agentCmd = builtin?.command || agent;
    const shimDir = path.resolve(argValue(rest, "dir") || defaultShimDir());
    const force = rest.includes("--force");
    const headlessOverride = argValue(rest, "headless");
    const headlessFlags = headlessOverride
      ? headlessOverride.trim().split(/\s+/).filter(Boolean)
      : (AGENT_HEADLESS_FLAGS[agent] || manifestHeadlessFlags(agent) || AGENT_HEADLESS_FLAGS.default);

    const shimPath = path.join(shimDir, agent);
    const real = resolveRealBinary(agentCmd, shimDir);
    if (!real && !force) {
      console.error(c.red(`Could not find the real "${agentCmd}" on PATH (outside ${shimDir}).`));
      console.error(c.dim(`Install it first, or re-run with --force to install the shim anyway (headless passthrough will fail until the binary exists).`));
      process.exit(1);
      return;
    }
    // Guard against overwriting a non-shim file (e.g. the real binary itself).
    if (fs.existsSync(shimPath)) {
      const existing = fs.readFileSync(shimPath, "utf8");
      if (!existing.includes(SHIM_MARKER) && !force) {
        console.error(c.red(`${shimPath} already exists and is not a Bivy shim. Refusing to overwrite (use --dir <dir> or --force).`));
        process.exit(1);
        return;
      }
    }

    fs.mkdirSync(shimDir, { recursive: true });
    const tmp = `${shimPath}.tmp`;
    fs.writeFileSync(tmp, renderShim({ agent, agentCmd, shimDir, realFallback: real, headlessFlags }), { mode: 0o755 });
    fs.renameSync(tmp, shimPath);
    fs.chmodSync(shimPath, 0o755);

    const data = loadShims();
    data.shims[agent] = { agent, agentCmd, shimPath, realPath: real, dir: shimDir, headlessFlags, installedAt: new Date().toISOString() };
    saveShims(data);

    console.log(c.green(`Installed shim: ${c.cyan(agent)} → ${shimPath}`));
    console.log(c.dim(`  real ${agentCmd}: ${real || "(not found — passthrough will fail)"}`));
    console.log(c.dim(`  headless passthrough flags: ${headlessFlags.join(" ") || "(none)"} (plus any non-TTY invocation)`));

    // The shim only fires if its dir wins over the real binary on the user's
    // interactive PATH. Rather than rely on the user's existing PATH order,
    // manage a marked block at the END of their shell rc (after version-manager
    // init) that force-moves the shim dir to the front.
    const sync = syncManagedPathBlock();
    if (sync.ok && sync.changed) {
      console.log(c.green(`\n  Updated PATH in ${tildify(sync.file)} so '${agent}' resolves to the shim in new shells.`));
    } else if (sync.ok) {
      console.log(c.dim(`\n  PATH already managed in ${tildify(sync.file)}.`));
    }

    // Verify against a fresh interactive shell (reflects the rc we just wrote +
    // any version managers), not this process's doctored PATH.
    const winner = activeAgentPath(agent);
    const wins = path.resolve(winner || "") === shimPath;
    if (wins) {
      console.log(c.dim(`  New shells: '${agent}' launches its native TUI in a Bivy PTY (remote-visible; resumable as chat). 'BIVY_SHIM_DISABLE=1 ${agent}' bypasses it.`));
      console.log(c.dim(`  This shell: run 'hash -r' (zsh: 'rehash'), or restart it, to pick up the change now.`));
    } else if (!sync.ok) {
      console.log(c.yellow(`\n  ⚠ Couldn't auto-manage your shell rc (shell: ${process.env.SHELL || "unknown"}).`));
      console.log(c.dim(`    Put ${shimDir} at the front of PATH, after your version-manager init, e.g.:`));
      console.log(c.dim(`      export PATH="${shimDir}:$PATH"`));
      console.log(c.dim(`    Then restart your shell (or 'hash -r') and run '${agent}'.`));
    } else {
      console.log(c.yellow(`\n  ⚠ ${shimDir} still isn't ahead of the real "${agent}" even after updating ${tildify(sync.file)}.`));
      console.log(c.dim(`    Something later in your shell startup re-prepends it; move the Bivy block to the end of ${tildify(sync.file)}.`));
    }
    return;
  }

  if (sub === "uninstall" || sub === "remove" || sub === "rm") {
    const agent = rest.find((a) => !a.startsWith("-"));
    if (!agent) { console.error(c.red("Usage: bivy shim uninstall <agent>")); process.exit(1); return; }
    const data = loadShims();
    const entry = data.shims[agent];
    const shimPath = entry?.shimPath || path.join(argValue(rest, "dir") || defaultShimDir(), agent);
    let removed = false;
    try {
      if (fs.existsSync(shimPath) && fs.readFileSync(shimPath, "utf8").includes(SHIM_MARKER)) {
        fs.rmSync(shimPath);
        removed = true;
      } else if (fs.existsSync(shimPath)) {
        console.error(c.red(`${shimPath} is not a Bivy shim — leaving it untouched.`));
      }
    } catch (error) {
      console.error(c.red(`Could not remove ${shimPath}: ${error?.message || String(error)}`));
    }
    if (entry) { delete data.shims[agent]; saveShims(data); }
    console.log(removed ? c.green(`Removed shim: ${agent} (${shimPath})`) : c.yellow(`No Bivy shim removed for "${agent}".`));
    // Reconcile the managed PATH block: rebuild it from the remaining shims, or
    // remove it entirely once none are left.
    const sync = syncManagedPathBlock();
    if (sync.ok && sync.changed && !sync.present) {
      console.log(c.dim(`  Removed the Bivy PATH block from ${tildify(sync.file)} (no shims left).`));
    } else if (sync.ok && sync.changed) {
      console.log(c.dim(`  Updated the Bivy PATH block in ${tildify(sync.file)}.`));
    }
    return;
  }

  // status / list (default)
  const data = loadShims();
  const agents = Object.keys(data.shims);
  console.log(c.bold("\n  Agent shims") + c.dim("  (bivy shim install <agent>)\n"));
  if (agents.length === 0) {
    console.log(c.dim("  none — install one with 'bivy shim install claude'"));
    console.log("");
    return;
  }
  for (const agent of agents) {
    const entry = data.shims[agent];
    const onDisk = fs.existsSync(entry.shimPath);
    // Check against a fresh interactive shell so this reflects the user's real
    // PATH (after their rc + version managers), not this process's doctored one.
    const active = path.resolve(activeAgentPath(agent) || "") === path.resolve(entry.shimPath);
    const state = !onDisk ? c.red("○ missing") : active ? c.green("● active") : c.yellow("○ shadowed on PATH");
    console.log(`  ${c.cyan(agent.padEnd(12))} ${state}`);
    console.log(c.dim(`    shim: ${entry.shimPath}`));
    console.log(c.dim(`    real: ${entry.realPath || "(unresolved)"}`));
  }
  console.log("");
}

// `bivy takeover <termId|session-id>` — "continue as chat": stop the native TUI
// running in a pinned run-terminal (started via the shim or `bivy run`) and
// reopen its pinned session as a governed chat you can drive from the app.
async function cmdTakeover(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy takeover <termId|session-id>\n\nStop a pinned run-terminal's native TUI (started via the shim or 'bivy run') and reopen its session as a governed chat you can drive from the app.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) { console.error(c.red("Usage: bivy takeover <termId|session-id>")); process.exit(1); return; }
  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) {
    console.error(c.red(`Could not start the Bivy node at ${url(config)}.`));
    process.exit(1);
    return;
  }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }
  // A bare UUID is a pinned session id; anything else is a run-terminal id.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const body = isUuid ? { sessionId: ref } : { termId: ref };
  try {
    const data = await localApi(config, "/api/terminals/takeover", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    console.log(c.green(`Took over → chat session ${c.cyan(data.sessionId)} (${data.runtimeId}).`));
    if (data.resumeCommand) console.log(c.dim(`Back to a terminal later with: ${data.resumeCommand}`));
    console.log(c.dim(`Open it in the app, or 'bivy resume ${data.sessionId}'.`));
  } catch (error) {
    console.error(c.red(error?.message || String(error)));
    process.exit(1);
  }
}

// `bivy exec "<prompt>"` — one-shot headless run: create/resume a session, send
// one prompt, print the final answer to stdout, exit. Working details go to
// stderr so stdout is pipe-clean. Delegates to src/exec.ts (needs the WS client).
// Deliberately does NOT intercept -h/--help here (unlike most other
// subcommands, #113): the prompt is free text, and 'bivy exec --help' is a
// legitimate (if odd) way to ask the agent about the --help flag.
async function cmdExec(args = []) {
  if (!(await ensureDeps())) process.exit(1);
  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) {
    console.error(c.red(`Could not start the Bivy node at ${url(config)}.`));
    process.exit(1);
    return;
  }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }
  const code = await run(nodeBin, [...nodeScriptArgs(execEntry), "--url", url(config), "--token", token, ...args], {
    cwd: repoRoot,
    env: startEnv(config),
  });
  process.exit(code);
}

// `bivy completions <bash|zsh|fish>` — print a shell completion script to eval or
// install. Covers the top-level commands and the built-in agent ids.
function cmdCompletions(args = []) {
  const shell = (args[0] || "").toLowerCase();
  const commands = [
    "run", "sessions", "ls", "resume", "promote", "rename", "nodes", "agents", "agents:install", "shim", "takeover", "token", "exec",
    "send", "attach", "kill", "setup", "start", "stop", "restart", "status", "doctor", "diagnostics", "logs", "login",
    "update", "update:log", "automation", "config", "plugin", "open", "service", "secrets", "voice", "link", "relay:setup",
    "github:connect", "github:app-create", "github:app-connect", "github:app-sync", "prune", "uninstall", "help", "version",
  ];
  const agents = [...BUILTIN_TERMINAL_AGENTS.keys()];

  if (shell === "bash") {
    console.log(`# bivy bash completion — add to ~/.bashrc:  eval "$(bivy completions bash)"
_bivy_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$cur") )
    return
  fi
  case "$prev" in
    run) COMPREPLY=( $(compgen -W "${agents.join(" ")}" -- "$cur") );;
  esac
}
complete -F _bivy_completions bivy`);
    return;
  }
  if (shell === "zsh") {
    console.log(`# bivy zsh completion — add to ~/.zshrc:  eval "$(bivy completions zsh)"
_bivy() {
  local -a cmds agents
  cmds=(${commands.map((x) => `'${x}'`).join(" ")})
  agents=(${agents.map((x) => `'${x}'`).join(" ")})
  if (( CURRENT == 2 )); then
    compadd -- $cmds
  elif [[ \${words[2]} == run ]]; then
    compadd -- $agents
  fi
}
compdef _bivy bivy`);
    return;
  }
  if (shell === "fish") {
    console.log(`# bivy fish completion — save to ~/.config/fish/completions/bivy.fish
complete -c bivy -f
complete -c bivy -n '__fish_use_subcommand' -a '${commands.join(" ")}'
complete -c bivy -n '__fish_seen_subcommand_from run' -a '${agents.join(" ")}'`);
    return;
  }
  console.error(c.red("Usage: bivy completions <bash|zsh|fish>"));
  process.exit(1);
}

// `bivy run <agent>` — launch a native agent in a daemon-owned PTY and bind this
// terminal to it. The session lives in the node, so it stays reachable from the
// web app (and resumable with `bivy resume`) after you leave. With `--node
// <name>` the session is started on another registered node instead.
//
// Future option: `bivy run --tmux <name>` could bind a pre-existing tmux/zellij/
// screen session (one NOT started by Bivy) into a daemon-owned PTY, making it
// remote-visible — the terminal entry point the removed `bivy attach --tmux`
// used to provide. The server side is still in place (multiplexer discovery +
// `terminal.open.mux`, used today by the web app); this would just re-add a CLI
// flag on top of it.
async function cmdRun(args = []) {
  if (!(await ensureDeps())) process.exit(1);
  const { name, model, node, workspace, clone, rest } = extractRunFlags(args);
  // Bare `bivy` (empty rest) resolves to the configured default agent; an
  // explicit `bivy run <agent>` keeps that agent verbatim.
  const [agentIdArg, ...extraArgs] = rest;
  const agentId = agentIdArg || resolveDefaultAgent();

  // A cloned/explicit workspace lives on THIS machine, so it only applies to the
  // local node. For a remote --node run the checkout would need to be made there.
  if (node && (clone !== undefined || workspace)) {
    console.error(c.red("--clone/--workspace apply to the local node; they can't be combined with --node (the workspace would only exist here)."));
    process.exit(1);
    return;
  }
  let clonedWorkspace;
  try { clonedWorkspace = resolveWorkspaceDir({ clone, workspace }); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }
  // `--model` is recorded as run-terminal metadata AND passed through to the
  // agent (claude/codex/gemini/aider/… accept `--model <model>`). Not injected
  // for the raw `-- <command>` form, where the user controls the full command.
  if (model && agentId !== "--") extraArgs.unshift("--model", model);
  const resolved = await resolveRunSpec(agentId, extraArgs);
  if (resolved.error) {
    console.error(c.red(resolved.error));
    process.exit(1);
    return;
  }

  // Pin a session id at launch when the agent's CLI supports it (and the caller
  // didn't already choose one), so the on-disk session is a known, deterministic
  // resume target — the anchor for later "continue as chat" adoption.
  const pinnedSessionId = pinRunSessionId(agentId, resolved.spec);
  if (pinnedSessionId) {
    console.log(c.dim(`session id ${pinnedSessionId} — resume in a terminal with '${agentId} --resume ${pinnedSessionId}'`));
  }

  // Remote target: start the session on another node.
  if (node) {
    let target;
    try { target = await resolveNodeTarget(node); }
    catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }

    // Account node with no direct route: tunnel through the relay (the same
    // path a phone uses). The command must resolve on the REMOTE node's PATH, so
    // send the agent's bare command rather than this machine's absolute path.
    if (target.source === "relay") {
      if (agentId !== "--" && terminalAgent(agentId).agent?.type === "native-pi") {
        console.error(c.red("Pi runs only on the local node. For --node, pick an installed agent (e.g. claude, codex)."));
        process.exit(1);
        return;
      }
      const remoteCommand = agentId === "--" ? resolved.spec.command : (terminalAgent(agentId).agent?.command || resolved.spec.command);
      const spec = { ...resolved.spec, command: remoteCommand, name, model, workspace: undefined };
      console.log(c.dim(`Starting on ${c.cyan(target.name)} over the relay…`));
      await run(nodeBin, [
        ...nodeScriptArgs(relayAttachEntry),
        "--node-id", target.nodeId,
        "--node-name", target.name,
        "--relay-config", relayConfigPath,
        "--attach-cmd", JSON.stringify(nodeScriptArgs(attachEntry)),
        "--run", JSON.stringify(spec),
      ], { cwd: repoRoot, env: process.env });
      return;
    }

    // Direct node: a reachable URL (LAN, Tailscale/VPN, SSH tunnel).
    if (!(await isUrlReachable(target.url))) {
      console.error(c.red(`Node "${node}" at ${target.url} is not reachable right now.`));
      process.exit(1);
      return;
    }
    const spec = { ...resolved.spec, name, model, workspace: undefined }; // workspace is the remote node's, not ours
    console.log(c.dim(`Starting on ${c.cyan(node)} (${target.url})…`));
    await run(nodeBin, [...nodeScriptArgs(attachEntry), "--url", target.url, ...(target.token ? ["--token", target.token] : []), "--run", JSON.stringify(spec)], {
      cwd: repoRoot,
      env: process.env,
    });
    return;
  }

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) {
    console.error(c.red(`Could not start the Bivy node at ${url(config)}.`));
    process.exit(1);
    return;
  }
  // No --clone/--workspace: start in the repo the user is standing in (see
  // defaultRunWorkspace). Announce it when it isn't the configured workspace, so
  // where the agent is rooted is never a silent surprise.
  const workspaceDir = clonedWorkspace || defaultRunWorkspace(config);
  if (!clonedWorkspace && workspaceDir !== (config.workspace || repoRoot)) {
    console.log(c.dim(`workspace ${workspaceDir}`));
  }
  const spec = { ...resolved.spec, name, model, workspace: workspaceDir };

  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }

  process.exit(await run(nodeBin, [...nodeScriptArgs(attachEntry), "--url", url(config), "--token", token, "--run", JSON.stringify(spec)], {
    cwd: repoRoot,
    env: startEnv(config),
  }));
}

// Short human age like "3m", "2h", "5d" from an ISO timestamp.
function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function truncate(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function statusGlyph(status) {
  if (status === "needs_action") return c.red("●");
  if (status === "working") return c.yellow("●");
  if (status === "idle") return c.green("●");
  return c.dim("○"); // saved / not open
}

async function fetchJson(baseUrl, pathName, token) {
  const res = await fetch(`${baseUrl}${pathName}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// `bivy sessions` / `bivy ls` — list ALL durable, resumable sessions (not just
// the ones currently live/active) plus live `bivy run` terminals, then resume
// the one you pick. Live terminals bind to their running PTY; durable sessions
// relaunch through `bivy run` using the agent's own native resume. `bivy resume`
// is the same list but jumps straight to a chosen (default: most recent) entry.
//   --json          machine-readable list, no prompt
//   --limit/-n N    cap how many saved sessions to show (default: unlimited — all of them)
//   <n> | <id>      select non-interactively (index in the list, or a session id)
async function cmdSessions(args = [], opts = {}) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(
      opts.autoResume
        ? "Usage: bivy resume [n|id] [--json]\n\nResume a session directly (default: most recent). Alias for 'bivy sessions' that jumps straight to a chosen entry."
        : "Usage: bivy sessions [n|id] [--json] [--limit N]\n\nList recent sessions (live + saved) and resume one. Alias: ls.",
    );
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const json = args.includes("--json");
  const nArg = argValue(args, "limit") || argValue(args, "n");
  // No explicit --limit/-n: show every saved session, not just the most recent
  // 15. Sessions are never "active" vs "inactive" in storage (see listAllSessions
  // in src/server.ts) — they persist until deleted or pruned — so capping the
  // default view made older, perfectly resumable sessions invisible and
  // unresumable by index. (#71)
  const limit = resolveSessionsLimit(nArg);
  const selector = args.find((a) => !a.startsWith("-"));

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) {
    console.error(c.red(`Could not start the Bivy node at ${url(config)}.`));
    process.exit(1);
    return;
  }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }

  const base = url(config);
  const [sessions, terminalsRes] = await Promise.all([
    fetchJson(base, "/api/sessions", token).catch(() => []),
    fetchJson(base, "/api/terminals", token).catch(() => ({ terminals: [] })),
  ]);
  const terminals = Array.isArray(terminalsRes?.terminals) ? terminalsRes.terminals : [];

  // Live PTYs first (attachable right now), then recent durable sessions.
  const liveItems = terminals.map((t) => ({
    kind: "live",
    ref: String(t.termId),
    agent: String(t.agent || t.label || "agent"),
    name: t.name || t.label || t.agent || "",
    model: t.model || "",
    workspace: t.workspace || "",
    status: "working",
  }));
  const savedItems = truncateSavedSessions(Array.isArray(sessions) ? sessions : [], limit)
    .map((s) => ({
      kind: "saved",
      ref: s.path || s.id,
      id: s.id,
      agent: String(s.agent || s.agentName || "agent"),
      agentName: s.agentName || s.agent || "",
      name: s.name || s.firstMessage || (s.id ? `session ${String(s.id).slice(0, 8)}` : "session"),
      model: "",
      workspace: s.workspace || "",
      status: s.status || "saved",
      when: relativeTime(s.lastActivityAt || s.updatedAt),
      costUsd: s.costUsd,
    }));
  const items = [...liveItems, ...savedItems];

  if (json) { console.log(JSON.stringify(items, null, 2)); return; }
  if (items.length === 0) {
    console.log(c.dim("No sessions yet. Start one with 'bivy run <agent>'."));
    return;
  }

  const renderRow = (item, i) => {
    const idx = c.cyan(String(i + 1).padStart(2));
    const tag = item.kind === "live" ? c.green("live") : c.dim(item.when || "").padStart(4);
    const agent = c.bold((item.agentName || item.agent || "agent").padEnd(8).slice(0, 8));
    const meta = [item.model && c.dim(item.model), item.workspace && c.dim(`~${path.basename(item.workspace)}`)].filter(Boolean).join(" ");
    return `  ${idx}  ${statusGlyph(item.status)} ${tag}  ${agent}  ${truncate(item.name, 48)}  ${meta}`;
  };

  // Non-interactive selection: an index (1-based) or a matching id/termId.
  let chosen;
  if (selector) {
    const asIndex = Number(selector);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= items.length) chosen = items[asIndex - 1];
    else chosen = items.find((it) => it.ref === selector || it.id === selector);
    if (!chosen) { console.error(c.red(`No session matching "${selector}".`)); process.exit(1); return; }
  } else if (opts.autoResume) {
    chosen = items[0]; // `bivy resume` with no arg → most recent
  }

  if (!chosen) {
    console.log(c.bold("\n  Sessions") + c.dim("  (live agents + all saved)\n"));
    items.forEach((item, i) => console.log(renderRow(item, i)));
    const prompter = createPrompter();
    const answer = await prompter.ask("Resume which? (number, or Enter to cancel)", "");
    prompter.close();
    if (!answer) { console.log(c.dim("Cancelled.")); return; }
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx < 1 || idx > items.length) { console.error(c.red("Not a valid selection.")); process.exit(1); return; }
    chosen = items[idx - 1];
  }

  await resumeSessionItem(chosen, config, token);
}

// `bivy kill <id>` — stop a session or run-terminal by id. A live run-terminal's
// PTY is closed; a durable session's current turn is aborted (add --delete to
// also remove the saved session). Ids come from `bivy sessions`.
async function cmdKill(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy kill <id> [--delete]\n\nStop a session/terminal. Ids come from 'bivy sessions'. --delete (alias --rm) also removes a saved session.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const del = args.includes("--delete") || args.includes("--rm");
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error(c.red("Usage: bivy kill <id> [--delete]")); process.exit(1); return; }

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not start the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }

  const base = url(config);
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  // Live run-terminal?
  const terminals = await fetchJson(base, "/api/terminals", token).then((d) => d.terminals || []).catch(() => []);
  if (terminals.some((t) => String(t.termId) === id)) {
    const res = await post("/api/terminals/close", { termId: id });
    console.log(res.ok ? c.green(`Killed run-terminal ${id}.`) : c.red(`Failed to kill ${id} (${res.status}).`));
    return;
  }

  // Otherwise treat it as a durable session id: abort the turn, optionally delete.
  const abort = await post("/api/session/abort", { sessionId: id });
  if (abort.ok) console.log(c.green(`Aborted session ${id}.`));
  else if (!del) { console.error(c.red(`No live terminal or session matching "${id}".`)); process.exit(1); return; }
  if (del) {
    const res = await post("/api/sessions/delete", { id });
    console.log(res.ok ? c.green(`Deleted session ${id}.`) : c.yellow(`Abort done; delete returned ${res.status}.`));
  }
}

// `bivy promote <id>` — continue a warm-replicated session on THIS node when its
// owner went offline (docs/session-replication.md). Runs against the local node,
// which does the control-plane epoch compare-and-set and materializes the replica
// worktree. Run it on the standby node that holds the replica.
async function cmdPromote(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy promote <session-id>\n\nContinue a warm-replicated session on THIS node when its owner went offline. Run it on the standby node that holds the replica.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error(c.red("Usage: bivy promote <session-id>")); process.exit(1); return; }
  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not start the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }
  const res = await fetch(`${url(config)}/api/session/promote`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id }),
  });
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    console.log(c.green(`Promoted ${id} to this node (epoch ${data.epoch ?? "?"}). Resume it with: bivy resume ${id}`));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(c.red(`Promotion failed (${res.status}): ${data.error || "unknown error"}`));
    process.exit(1);
  }
}

// `bivy rename <name>` — rename THIS node. Runs against the local daemon, which
// persists the name to .bivy/node.json and live-updates relay/work-queue routing
// (no restart needed). If the name collides on your account the control plane
// auto-adjusts it for uniqueness, so we re-read the node info afterward to show
// the name that actually stuck. Alias: node:rename.
async function cmdRename(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log('Usage: bivy rename <name>\n\nRename this node. Takes effect immediately (no restart). If the name is already used by another node on your account, it is auto-adjusted to stay unique.');
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  // Node names may contain spaces, so join all positional (non-flag) args rather
  // than taking only the first. The daemon trims/collapses whitespace and caps
  // the length; we just forward the raw text.
  const name = args.filter((a) => !a.startsWith("-")).join(" ").trim();
  if (!name) { console.error(c.red("Usage: bivy rename <name>")); process.exit(1); return; }

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not start the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }

  const base = url(config);
  const prev = await fetchJson(base, "/api/node/info", token).then((d) => d?.name).catch(() => undefined);
  const res = await fetch(`${base}/api/node/name`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error(c.red(`Rename failed (${res.status}): ${data.error || "unknown error"}`));
    process.exit(1);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const applied = data.name || name;
  if (prev && prev !== applied) console.log(c.green(`Renamed node: ${c.dim(prev)} → ${applied}`));
  else console.log(c.green(`Node name set to "${applied}".`));
  if (applied !== name) console.log(c.dim(`(Adjusted from "${name}" to stay unique on your account.)`));
}

// `bivy send <id> "<message>"` — send a prompt to an existing session and stream
// the reply. Thin wrapper over the headless exec client with --session.
// Deliberately does NOT intercept -h/--help (see cmdExec above) — the message
// is free text a caller may legitimately want to send verbatim.
async function cmdSend(args = []) {
  if (!(await ensureDeps())) process.exit(1);
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error(c.red('Usage: bivy send <id> "<message>"')); process.exit(1); return; }
  const message = args.filter((a) => a !== id);
  if (message.length === 0) { console.error(c.red('Usage: bivy send <id> "<message>"')); process.exit(1); return; }

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not start the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  let token;
  try { token = await localDeviceToken(config); }
  catch (error) { console.error(c.red(error?.message || String(error))); process.exit(1); return; }
  const code = await run(nodeBin, [...nodeScriptArgs(execEntry), "--url", url(config), "--token", token, "--session", id, ...message], {
    cwd: repoRoot,
    env: startEnv(config),
  });
  process.exit(code);
}

// `bivy attach <file> [--caption "…"] [--session <id>]` — surface a file the
// agent produced into the chat as an image/file attachment (the reverse of the
// composer paperclip). The universal path: any agent that can run a shell command
// can call this. The session id defaults to $BIVY_SESSION_ID, which every
// runtime adapter injects into the agent's subprocess env (see
// src/runtime/session-env.ts) — except pi, whose SDK exposes its own
// $PI_SESSION_ID instead (same id, different var name; see
// resolveAttachSessionId). The file is resolved to an absolute path here (the
// CLI's cwd is the agent's workdir) and confined to the session workspace
// server-side.
async function cmdAttach(args = []) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const sessionId = resolveAttachSessionId({ sessionFlag: flag("--session"), env: process.env });
  const caption = flag("--caption");
  const name = flag("--name");
  const mimeType = flag("--mime") || flag("--mimeType");
  const flagsWithValue = new Set(["--session", "--caption", "--name", "--mime", "--mimeType"]);
  // First positional that isn't a flag or a flag's value.
  let file;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) { if (flagsWithValue.has(a)) i++; continue; }
    if (i > 0 && flagsWithValue.has(args[i - 1])) continue;
    file = a;
    break;
  }
  if (!file) { console.error(c.red('Usage: bivy attach <file> [--caption "…"] [--session <id>]')); process.exit(1); return; }
  if (!sessionId) { console.error(c.red("No session id. Set --session <id> or run inside an agent session ($BIVY_SESSION_ID).")); process.exit(1); return; }
  const absPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absPath)) { console.error(c.red(`File not found: ${file}`)); process.exit(1); return; }

  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not reach the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  // A token isn't required on a single-user host (loopback bypasses auth), but
  // include it when available so multi-user hosts work too.
  let token;
  try { token = await localDeviceToken(config); } catch { token = undefined; }
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${url(config)}/api/session/${encodeURIComponent(sessionId)}/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: absPath, caption, name, mimeType }),
    });
  } catch (error) {
    console.error(c.red(`Could not reach the Bivy node: ${error?.message || String(error)}`));
    process.exit(1);
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(c.red(`Attach failed (${res.status}): ${body?.error || "unknown error"}`)); process.exit(1); return; }
  console.log(c.green(`Attached ${body.name} (${body.kind}, ${body.size} bytes) to the chat.`));
}

// Map a saved session's runtime id to the `bivy run` agent whose native CLI can
// resume it in a terminal. Only agents with a real native resume qualify; other
// runtimes (generic-cli, SDK-only) have no terminal resume and open in the web app.
function nativeResumeAgent(runtimeId) {
  const id = (runtimeId || "").toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("codex")) return "codex";
  return null;
}

// Resume a chosen session in a Bivy-managed, relay-visible PTY: bind the live PTY
// for a running `bivy run` terminal, or relaunch a durable session through
// `bivy run` using the agent's own native resume (e.g. `claude --resume <id>`).
async function resumeSessionItem(item, config, token) {
  if (item.kind === "live") {
    console.log(c.dim(`Attaching to ${c.cyan(item.name || item.ref)}…`));
    await run(nodeBin, [...nodeScriptArgs(attachEntry), "--url", url(config), "--token", token, "--attach", item.ref], {
      cwd: repoRoot,
      env: startEnv(config),
    });
    return;
  }
  const agentId = nativeResumeAgent(item.agent);
  if (!agentId) {
    console.log(c.yellow(`"${item.name}" (${item.agentName || item.agent}) has no native terminal resume; open it in the web app with 'bivy open'.`));
    return;
  }
  const resumeArgs = agentResumeArgs(agentId, item.id || item.ref);
  const runArgs = [agentId, ...resumeArgs];
  if (item.workspace) runArgs.push("--workspace", item.workspace); // native resume finds the session by its original cwd
  console.log(c.dim(`Resuming ${c.cyan(item.name)} with ${agentId} ${resumeArgs.join(" ")}…`));
  await cmdRun(runArgs);
}

// --- prune ------------------------------------------------------------------
// `bivy prune` — reclaim disk by removing old data on THIS node: saved sessions
// across every agent (the .bivy/metadata.json index + the owning agent's on-disk
// transcript — Pi's .bivy/pi/sessions, Claude Code's ~/.claude/projects, Codex's
// $CODEX_HOME/sessions), ephemeral `--clone` checkouts (.bivy/workspaces), and git
// worktrees (*/.bivy/worktrees). Retention is by
// count (--keep N: the newest N of each kind survive) and/or age (--older-than
// <spec>: only items older than that are eligible). With both, an item is
// removed only when it is BOTH beyond the newest N AND older than the age — the
// safe intersection. Paths default to the installed node's data dir (appDir)
// and the configured workspace; the primary workspace itself, Docker, and named
// volumes are never touched. This is the node-side session/worktree cleanup;
// deploy/prune.sh only reclaims Docker cruft on the host.

// Parse an age spec like "7d", "12h", "30m", "45s", "2w", or a plain number
// (interpreted as days). Returns milliseconds, or null when the spec is invalid.
function parseAgeSpec(spec) {
  const m = String(spec || "").trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult = { s: 1e3, m: 60e3, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[(m[2] || "d").toLowerCase()];
  return n * mult;
}

// Direct children of `dir` as { path, mtimeMs }. type "dir" keeps only
// directories (workspaces/worktrees); "any" also keeps files (session records,
// which may be a `<id>.json` file or a `<id>/` directory).
function pruneListEntries(dir, type = "any") {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of ents) {
    if (type === "dir" && !ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    try { out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs }); } catch { /* vanished */ }
  }
  return out;
}

// Bounded search for `*/.bivy/worktrees` roots under each scan root. Skips
// node_modules/.git and stops at maxDepth so scanning a big workspace repo stays
// cheap, and never descends into a worktrees dir it finds.
function findWorktreeRoots(scanRoots, maxDepth = 6) {
  const roots = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name === "node_modules" || ent.name === ".git") continue;
      if (ent.name === "worktrees" && path.basename(dir) === ".bivy") { roots.add(path.join(dir, ent.name)); continue; }
      walk(path.join(dir, ent.name), depth + 1);
    }
  };
  for (const root of scanRoots) if (root && fs.existsSync(root)) walk(root, 0);
  return [...roots];
}

// Removal set from a list of entries: sort newest-first, then keep those that are
// BOTH beyond the newest `keep` AND older than `ageMs`. A null bound disables its
// half of the test (so keep-only or age-only both work).
function selectStale(entries, keep, ageMs, now) {
  return [...entries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .filter((e, i) => (keep === null || i >= keep) && (ageMs === null || now - e.mtimeMs >= ageMs));
}

// --- session pruning -------------------------------------------------------
// Sessions are NOT plain files under one directory: since terminal-started
// agents were adopted (shim → Bivy PTY → "continue as chat"), the sessions the
// app lists come from `.bivy/metadata.json` (the durable, deletion-aware index
// that drives the sidebar) plus each agent's own transcript store
// (~/.claude/projects/<cwd>/<id>.jsonl, $CODEX_HOME/sessions/**/rollout-*-<id>.jsonl,
// .bivy/pi/sessions/*.jsonl for Pi). The old prune only scanned .bivy/pi/sessions,
// so it silently no-oped for every shim/native-agent session. These helpers make
// `--sessions` operate on the metadata index (the real source of truth) and reclaim
// the underlying transcript on disk.

function metadataFilePath(dataDir) { return path.join(dataDir, "metadata.json"); }

// All sessions recorded in metadata.json, as an array. Best-effort: a missing or
// malformed file yields an empty list (nothing to prune). Selection logic lives
// in ./prune-sessions.mjs (pure + unit-tested).
function loadMetadataSessions(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataFilePath(dataDir), "utf8"));
    const sessions = parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {};
    return { file: parsed, sessions: Object.values(sessions) };
  } catch {
    return { file: null, sessions: [] };
  }
}

// Candidate roots where the Claude Code SDK persists transcripts
// (~/.claude/projects/<encoded-cwd>/<id>.jsonl). BIVY_CLAUDE_SESSIONS_DIR, when
// set, overrides the store the daemon reads/writes.
function claudeProjectRoots() {
  const roots = [path.join(os.homedir(), ".claude", "projects")];
  const override = process.env.BIVY_CLAUDE_SESSIONS_DIR?.trim();
  if (override) roots.push(path.join(override, "projects"), override);
  return roots;
}
function codexSessionsRoot() {
  return path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "sessions");
}

// Every on-disk transcript file for a session, located by id. Deleting these
// reclaims the disk AND stops disk-listing adapters (e.g. Codex enumerates its
// rollouts from disk) from re-surfacing a session we've forgotten. Best-effort:
// a store we can't read is skipped, not fatal.
function nativeTranscriptFiles(session) {
  const files = new Set();
  const id = String(session.id || "");
  // Pi and any runtime that records an absolute transcript path.
  if (session.path && path.isAbsolute(session.path) && fs.existsSync(session.path)) files.add(path.resolve(session.path));
  if (!id) return [...files];
  const runtime = String(session.runtimeId || "");
  if (/claude/i.test(runtime)) {
    for (const projects of claudeProjectRoots()) {
      let dirs;
      try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { continue; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const f = path.join(projects, d.name, `${id}.jsonl`);
        if (fs.existsSync(f)) files.add(f);
      }
    }
  }
  if (/codex/i.test(runtime)) {
    // rollout-<timestamp>-<uuid>.jsonl nested under sessions/YYYY/MM/DD.
    const stack = [codexSessionsRoot()];
    while (stack.length) {
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && /\.jsonl$/.test(e.name) && e.name.includes(id)) files.add(full);
      }
    }
  }
  return [...files];
}

// Offline removal of sessions from metadata.json (used when the daemon isn't
// reachable, so there's no in-memory store to race with). Rewrites the file
// atomically in the same shape MetadataStore.save() uses.
function removeSessionsFromMetadata(dataDir, ids) {
  const filePath = metadataFilePath(dataDir);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
  if (!parsed || typeof parsed.sessions !== "object" || !parsed.sessions) return;
  let changed = false;
  for (const id of ids) {
    if (parsed.sessions[id]) { delete parsed.sessions[id]; changed = true; }
  }
  if (!changed) return;
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// Delete a selected set of sessions. When the daemon is reachable we POST to
// /api/sessions/delete so the server updates its in-memory index, drops sidecars
// and broadcasts the removal to connected clients — and it refuses live/busy
// sessions, so we only reclaim the native transcript once the server has agreed
// to forget the session. When the daemon is down we edit metadata.json directly.
// Returns the number of sessions actually removed.
async function deletePrunedSessions(sessions, dataDir, { dryRun, json }) {
  if (dryRun) return sessions.length;

  const config = loadConfig();
  const base = url(config);
  const reachable = await isUrlReachable(base);
  let token = null;
  if (reachable) {
    try { token = await localDeviceToken(config); } catch { token = null; }
  }
  const useApi = reachable && !!token;

  const short = (id) => String(id ?? "").slice(0, 8);
  let removed = 0;
  const offlineIds = [];

  for (const s of sessions) {
    if (useApi) {
      let ok = false;
      try {
        // Send an absolute transcript path only (Pi) — the server unlinks it and
        // rejects a non-absolute path with no open record. Native runtimes store
        // `path` as a bare session id, so delete those by id and reclaim their
        // transcript ourselves below.
        const abs = s.path && path.isAbsolute(s.path) ? { path: s.path } : {};
        const res = await fetch(`${base}/api/sessions/delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ id: s.id, ...abs }),
        });
        ok = res.ok;
        if (!ok && !json) console.log(c.yellow(`  skipped session ${short(s.id)} (server returned ${res.status})`));
      } catch (err) {
        if (!json) console.log(c.yellow(`  could not delete session ${short(s.id)}: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      }
      if (!ok) continue; // busy/working session left intact, transcript untouched
    } else {
      offlineIds.push(s.id);
    }
    // Reclaim the agent's on-disk transcript(s). The server's delete endpoint
    // deliberately leaves native (Claude/Codex) transcripts in place, and Codex
    // re-lists sessions from disk — so removing the file is what actually frees
    // the space and keeps the session from reappearing.
    for (const file of nativeTranscriptFiles(s)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    removed++;
  }

  if (offlineIds.length) removeSessionsFromMetadata(dataDir, offlineIds);
  return removed;
}

function shortAge(mtimeMs, now) {
  const sec = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr}h` : `${Math.round(hr / 24)}d`;
}

// Worktree dirs currently backing a live agent on this node. The daemon owns
// every session runtime and run-terminal PTY, so when it's reachable we ask it
// which worktrees are in use and never prune those — no matter how the keep/age
// policy scores them (a long-running-but-quiet agent can have an old mtime). When
// the daemon is down there are no live runtimes at all, so an mtime-only prune is
// already safe. Returns { reachable, paths } with paths a Set of resolved dirs.
async function liveWorktreePaths(config) {
  const base = url(config);
  if (!(await isUrlReachable(base))) return { reachable: false, paths: new Set() };
  let token = null;
  try { token = await localDeviceToken(config); } catch { token = null; }
  const [sessions, terminalsRes] = await Promise.all([
    fetchJson(base, "/api/sessions", token).catch(() => []),
    fetchJson(base, "/api/terminals", token).catch(() => ({ terminals: [] })),
  ]);
  const paths = new Set();
  const add = (p) => { if (p && typeof p === "string") paths.add(path.resolve(p)); };
  // Open sessions (a live in-memory runtime) that are backed by a worktree.
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && s.open) add(s.bivySession?.worktree || s.worktree);
  }
  // Run-terminals (native TUIs / `bivy run`): their workspace is the PTY's cwd,
  // which for a worktree-backed session is the worktree itself.
  const terminals = Array.isArray(terminalsRes?.terminals) ? terminalsRes.terminals : [];
  for (const t of terminals) add(t?.workspace);
  return { reachable: true, paths };
}

// True when worktree dir `entryPath` is — or contains, or sits inside — a path a
// live agent is using, so pruning it would pull the rug from a running session.
function isLiveWorktree(entryPath, livePaths) {
  const e = path.resolve(entryPath);
  for (const l of livePaths) {
    if (l === e || l.startsWith(e + path.sep) || e.startsWith(l + path.sep)) return true;
  }
  return false;
}

function printPruneHelp() {
  console.log(`
${c.bold("bivy prune")} — remove old sessions, --clone workspaces, and git worktrees on this node

  ${c.cyan("bivy prune --keep 10")}          Keep the newest 10 of each kind, remove the rest
  ${c.cyan("bivy prune --older-than 7d")}    Remove anything older than 7 days (also 12h, 30m, 2w, or a bare number = days)
  ${c.cyan("bivy prune --keep 5 --older-than 14d")}  Keep newest 5 AND anything newer than 14d (safe intersection)
  ${c.cyan("bivy prune --dry-run")}          Show what would be removed, delete nothing

  Scope (default: all three)
    --sessions            saved sessions across all agents (metadata index +
                          the agent's transcript: Pi, Claude Code, Codex, …)
    --workspaces          ephemeral --clone checkouts (.bivy/workspaces)
    --worktrees           git worktrees (*/.bivy/worktrees)

  Sessions: the newest N non-empty sessions (any agent) survive; empty/untitled
  and live sessions are handled specially — live ones are never removed. Routed
  through the running node when reachable so its session index stays consistent.

  Worktrees: a worktree backing a live agent (an open session or a run-terminal)
  is never pruned while the node is running, regardless of --keep/--older-than —
  only idle worktrees are removed. If the node is down, nothing is live to guard.

  Paths (default to the installed node)
    --data-dir <dir>      node data dir (default: this install's .bivy, or $BIVY_DATA_DIR)
    --workspace <dir>     also scan this workspace for worktrees (default: configured workspace)

  Safety
    --dry-run             list what would be removed and delete nothing
    -y, --yes             skip the confirmation prompt
    --json                machine-readable output (non-interactive; still deletes unless --dry-run)

  With neither --keep nor --older-than, the default keeps the newest 10 sessions
  but only the newest 3 workspaces and 3 worktrees — those are full checkouts
  (a ~1GB node_modules each), so keeping 10 reclaims little. Pass --keep N to
  apply one count to every kind.
`);
}

async function cmdPrune(args = []) {
  if (args.includes("-h") || args.includes("--help")) { printPruneHelp(); return; }

  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("-y") || args.includes("--yes") || json;

  // Retention policy: --keep N and/or --older-than <spec>. Default keep 10 when
  // neither is given, so a bare `bivy prune` can never wipe everything.
  const keepArg = argValue(args, "keep");
  const ageArg = argValue(args, "older-than");
  let keep = null;
  if (keepArg !== "") {
    const n = Number(keepArg);
    if (!Number.isFinite(n) || n < 0) { console.error(c.red("--keep must be a non-negative integer.")); process.exit(1); return; }
    keep = Math.floor(n);
  }
  let ageMs = null;
  if (ageArg !== "") {
    ageMs = parseAgeSpec(ageArg);
    if (ageMs === null) { console.error(c.red("--older-than must be like 7d, 12h, 30m, 2w, or a plain number of days.")); process.exit(1); return; }
  }
  // Default retention when the user passes neither --keep nor --older-than.
  // Worktrees and ephemeral --clone workspaces are full checkouts (each often a
  // ~1GB node_modules), so a uniform keep-10 reclaims almost nothing on a node
  // that never held more than 10 of them — the exact case where disk creeps up.
  // Give the heavy, regenerable kinds a tighter default than cheap session
  // transcripts; a worktree's branch/commits live in the repo's .git, not the
  // worktree, and live worktrees are guarded separately, so this only removes
  // idle, disposable checkouts. An explicit --keep/--older-than still applies
  // uniformly to every kind.
  const usingDefaultPolicy = keep === null && ageMs === null;
  const DEFAULT_KEEP = { sessions: 10, workspaces: 3, worktrees: 3 };
  const keepFor = (kind) => (usingDefaultPolicy ? DEFAULT_KEEP[kind] : keep);

  // Category selection: default to all three when no category flag is given.
  const flagged = ["--sessions", "--workspaces", "--worktrees"].filter((f) => args.includes(f));
  const doSessions = flagged.length === 0 || flagged.includes("--sessions");
  const doWorkspaces = flagged.length === 0 || flagged.includes("--workspaces");
  const doWorktrees = flagged.length === 0 || flagged.includes("--worktrees");

  // Paths come from the real install: the node data dir (appDir / $BIVY_DATA_DIR)
  // and the configured workspace folder (cli.json), unless overridden.
  const dataDir = argValue(args, "data-dir") || process.env.BIVY_DATA_DIR || appDir;
  const config = loadConfig();
  const wsArg = argValue(args, "workspace");
  const workspace = wsArg ? path.resolve(wsArg.replace(/^~(?=$|\/)/, os.homedir())) : config.workspace;

  const now = Date.now();
  const plan = [];
  let worktreeGuard = { reachable: false, protected: 0 };
  if (doSessions) {
    // Sessions live in the metadata index (all agents) plus each agent's own
    // transcript store — not just .bivy/pi/sessions. Select from metadata so
    // shim/native (Claude Code, Codex, …) sessions are actually covered; the old
    // pi-sessions-only scan silently no-oped for every terminal-started session.
    const staleSessions = selectStaleSessions(loadMetadataSessions(dataDir).sessions, keepFor("sessions"), ageMs, now);
    plan.push({
      kind: "sessions",
      root: metadataFilePath(dataDir),
      remove: staleSessions.map((s) => {
        // Label honestly: a session with a first message but no name shows that
        // message; one with no name AND no message is an empty shell, not lost
        // work — call it "(empty)" rather than "untitled" so a list full of them
        // reads for what it is.
        const title = String(s.name || s.firstMessage || "").trim();
        const label = title || (Number(s.messageCount ?? 0) > 0 ? "untitled" : "(empty)");
        return {
          path: `${String(s.id || "?").slice(0, 8)} · ${label.slice(0, 40)}`,
          mtimeMs: sessionActivityMs(s),
          session: s,
        };
      }),
    });
  }
  if (doWorkspaces) {
    const dir = path.join(dataDir, "workspaces");
    plan.push({ kind: "workspaces", root: dir, remove: selectStale(pruneListEntries(dir, "dir"), keepFor("workspaces"), ageMs, now) });
  }
  if (doWorktrees) {
    // Keep the newest N worktrees overall (across all roots), matching the node
    // prune script. Scan roots: the data dir plus the configured workspace repo.
    const roots = findWorktreeRoots([dataDir, workspace].filter(Boolean));
    const all = roots.flatMap((r) => pruneListEntries(r, "dir"));
    const stale = selectStale(all, keepFor("worktrees"), ageMs, now);
    // Guard: never delete a worktree a live agent is using. Ask the daemon what's
    // live (it owns every runtime and PTY); protected worktrees drop out of the
    // removal set entirely, so an aggressive --older-than can't nuke a running
    // agent's checkout. Node down ⇒ nothing live ⇒ policy alone is safe.
    const live = await liveWorktreePaths(config);
    const remove = stale.filter((e) => !isLiveWorktree(e.path, live.paths));
    worktreeGuard = { reachable: live.reachable, protected: stale.length - remove.length };
    plan.push({ kind: "worktrees", root: roots.join(", ") || "(none found)", remove });
  }
  const total = plan.reduce((n, p) => n + p.remove.length, 0);

  const policy = usingDefaultPolicy
    ? `defaults — keep newest ${DEFAULT_KEEP.sessions} sessions · ${DEFAULT_KEEP.worktrees} workspaces/worktrees`
    : [keep !== null ? `keep newest ${keep}` : null, ageMs !== null ? `older than ${ageArg}` : null].filter(Boolean).join(" & ");

  if (!json) {
    console.log(c.bold("\n  bivy prune") + c.dim(`  (${dryRun ? "dry run — " : ""}${policy})\n`));
    console.log(c.dim(`  data dir:  ${dataDir}`));
    console.log(c.dim(`  workspace: ${workspace || "(none)"}\n`));
    for (const p of plan) {
      const label = p.kind.padEnd(11);
      if (p.remove.length === 0) { console.log(`  ${label}${c.dim("nothing to remove")}`); continue; }
      console.log(`  ${label}${c.yellow(String(p.remove.length))} to remove`);
      for (const e of p.remove.slice(0, 6)) console.log(`    ${c.dim(shortAge(e.mtimeMs, now).padStart(4))}  ${c.dim(path.basename(e.path))}`);
      if (p.remove.length > 6) console.log(c.dim(`    …and ${p.remove.length - 6} more`));
    }
    console.log("");
    if (doWorktrees && worktreeGuard.protected > 0) {
      console.log(c.dim(`  Protected ${c.green(String(worktreeGuard.protected))} worktree(s) in use by a live agent — never pruned.`));
    }
    if (doWorktrees && !worktreeGuard.reachable) {
      console.log(c.dim("  Node not reachable — no live agents to guard; worktrees pruned by policy only."));
    } else {
      console.log(c.dim("  Live sessions/worktrees are protected automatically; empty/untitled sessions can still go — prune when idle for the cleanest result."));
    }
    console.log("");
  }

  if (total === 0) {
    if (json) console.log(JSON.stringify({ dataDir, workspace, keep, keepByKind: { sessions: keepFor("sessions"), workspaces: keepFor("workspaces"), worktrees: keepFor("worktrees") }, olderThanMs: ageMs, dryRun, total: 0, removed: 0, worktreesProtected: worktreeGuard.protected }, null, 2));
    else console.log(c.green("Nothing to prune. ✓"));
    return;
  }

  if (!dryRun && !yes) {
    const rl = createPrompter();
    const ok = await rl.askYesNo(`Remove ${total} item(s)? This cannot be undone.`, false);
    rl.close();
    if (!ok) { console.log(c.dim("Cancelled.")); return; }
  }

  let removed = 0;
  const touchedRepos = new Set();
  for (const p of plan) {
    // Sessions are not plain files — they need agent-aware, daemon-consistent
    // deletion (handled below), so skip them in the generic file-removal loop.
    if (p.kind === "sessions") continue;
    for (const e of p.remove) {
      if (dryRun) { removed++; continue; }
      try {
        fs.rmSync(e.path, { recursive: true, force: true });
        removed++;
        // A worktree lives at <repoRoot>/.bivy/worktrees/<slug>; remember its repo
        // root so we can drop the now-dangling git registration afterwards.
        if (p.kind === "worktrees") touchedRepos.add(path.dirname(path.dirname(path.dirname(e.path))));
      } catch (err) {
        if (!json) console.log(c.yellow(`  could not remove ${e.path}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }
  if (!dryRun && touchedRepos.size && commandExists("git")) {
    for (const repo of touchedRepos) runQuiet("git", ["-C", repo, "worktree", "prune"]);
  }

  // Sessions: route deletion through the running daemon when it's reachable, so
  // its in-memory metadata store (re-persisted on every event) can't resurrect
  // rows we delete on disk; fall back to a direct metadata rewrite when the node
  // is down. Either path also removes the agent's on-disk transcript to reclaim space.
  const sessionPlan = plan.find((p) => p.kind === "sessions");
  if (sessionPlan?.remove.length) {
    removed += await deletePrunedSessions(sessionPlan.remove.map((e) => e.session), dataDir, { dryRun, json });
  }

  if (json) {
    console.log(JSON.stringify({ dataDir, workspace, keep, keepByKind: { sessions: keepFor("sessions"), workspaces: keepFor("workspaces"), worktrees: keepFor("worktrees") }, olderThanMs: ageMs, dryRun, total, removed, worktreesProtected: worktreeGuard.protected, plan: plan.map((p) => ({ kind: p.kind, removed: p.remove.length })) }, null, 2));
  } else if (dryRun) {
    console.log(c.dim(`Dry run: ${removed} item(s) would be removed. Re-run without --dry-run to delete.`));
  } else {
    console.log(c.green(`Removed ${removed} item(s).`));
  }
}

async function isReachable(config) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    // Probe the dedicated liveness endpoint rather than `/`, whose response
    // depends on the PWA shell asset being present. Any HTTP response (even a
    // 404 from an older node without /healthz) means the node is up; only a
    // connection error or a 5xx counts as unreachable.
    const res = await fetch(`${url(config)}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Simple line-buffered prompter.
 *
 * Important: do NOT give readline an `output` stream / terminal control here.
 * On SSH terminals that caused readline to redraw and partially erase the
 * previous prompt, so users could not see which question they were answering.
 * We print prompts ourselves, one per line, and let the tty echo typed input.
 */
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  const buffer = [];
  const waiters = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffer.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()("");
  });

  const nextLine = () =>
    new Promise((resolve) => {
      if (buffer.length) resolve(buffer.shift());
      else if (closed) resolve("");
      else waiters.push(resolve);
    });

  const ask = async (question, fallback) => {
    const suffix = fallback ? c.dim(` [default: ${fallback}]`) : "";
    process.stdout.write(`\n${c.cyan("›")} ${question}${suffix}\n  > `);
    const line = await nextLine();
    return line.trim() || fallback || "";
  };

  const askChoice = async (question, choices, fallback) => {
    for (;;) {
      const menu = choices.map((choice) => `    ${c.cyan(choice.key)}  ${choice.label}`).join("\n");
      const suffix = fallback ? c.dim(` [default: ${fallback}]`) : "";
      process.stdout.write(`\n${c.cyan("›")} ${question}\n${menu}\n  >${suffix} `);
      const answer = String(await nextLine()).trim().toLowerCase() || fallback || "";
      const match = choices.find((choice) => answer === choice.key || answer === choice.label.toLowerCase());
      if (match) return match.key;
      console.log(c.yellow(`Please choose one of: ${choices.map((choice) => choice.key).join(", ")}`));
    }
  };

  const askYesNo = async (question, defaultYes) => {
    const hint = defaultYes ? "Y/n" : "y/N";
    for (;;) {
      const answer = (await ask(`${question} ${c.dim(`(${hint})`)}`, "")).toLowerCase();
      if (!answer) return defaultYes;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      console.log(c.yellow("Please answer yes or no."));
    }
  };

  return { ask, askChoice, askYesNo, close: () => rl.close(), pause: () => rl.pause(), resume: () => rl.resume() };
}

// --- service management -----------------------------------------------------

function servicePaths() {
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      file: path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    };
  }
  if (process.platform === "linux") {
    return {
      kind: "systemd",
      file: path.join(os.homedir(), ".config", "systemd", "user", SERVICE_UNIT),
    };
  }
  return { kind: "unsupported", file: "" };
}

function plistContent(config) {
  const envEntries = Object.entries({
    PORT: String(config.port),
    BIVY_WORKSPACE: config.workspace,
    BIVY_DATA_DIR: appDir,
    ...config.env,
    PATH: commandPath(config.env?.PATH),
  })
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${escapeXml(String(v))}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    ${tsxCli ? `<string>${escapeXml(tsxCli)}</string>\n    ` : ""}<string>${escapeXml(serverEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/bivy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/bivy.err.log</string>
</dict>
</plist>
`;
}

function systemdEscapeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function systemdContent(config) {
  const envLines = Object.entries({
    PORT: String(config.port),
    BIVY_WORKSPACE: config.workspace,
    BIVY_DATA_DIR: appDir,
    ...config.env,
    PATH: commandPath(config.env?.PATH),
  })
    .map(([k, v]) => `Environment="${k}=${systemdEscapeValue(v)}"`)
    .join("\n");
  return `[Unit]
Description=Bivy node
After=network.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodeBin} ${nodeScriptArgs(serverEntry).map(systemdEscapeValue).join(" ")}
Restart=always
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function installService(config) {
  if (detectInstallKind() === "npx") {
    console.log(c.yellow("Refusing to install a background service from an ephemeral 'npx bivy' run."));
    console.log(c.dim(`The service would point at the temporary npx cache (${repoRoot}), which npm can delete at any time, leaving a broken unit.`));
    console.log(`Install a persistent copy first: ${c.cyan("npm i -g @bivy/bivy")}, then run ${c.cyan("bivy service install")}.`);
    return false;
  }
  const { kind, file } = servicePaths();
  if (kind === "unsupported") {
    console.log(c.yellow(`No background-service template for ${process.platform}. Use 'bivy start' instead.`));
    return false;
  }
  // Re-check the port before baking it into the unit: a second node on this
  // machine may have claimed the saved port since setup, and unlike `bivy setup`
  // this path used to write it in verbatim (so the node would fail to bind and
  // silently exit). reconcileNodePort persists any change into `config` first.
  await reconcileNodePort(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (kind === "launchd") {
    fs.writeFileSync(file, plistContent(config));
    runQuiet("launchctl", ["unload", file]);
    const res = runQuiet("launchctl", ["load", "-w", file]);
    if (res.code !== 0) {
      console.error(c.red(`launchctl load failed: ${res.stderr.trim()}`));
      return false;
    }
  } else {
    fs.writeFileSync(file, systemdContent(config));
    const username = os.userInfo().username;
    // Best effort. This succeeds when run as root, via sudo permissions, or on
    // systems that allow users to enable their own linger. It is safe to try
    // before systemctl so a direct SSH-less install has a better chance to work.
    const linger = runQuiet("loginctl", ["enable-linger", username]);
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`;
    const systemdEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    runQuiet("systemctl", ["--user", "daemon-reload"], { env: systemdEnv });
    const res = runQuiet("systemctl", ["--user", "enable", "--now", SERVICE_UNIT], { env: systemdEnv });
    if (res.code !== 0) {
      console.error(c.red("Could not start the systemd user service from this shell."));
      console.error(c.dim((res.stderr || res.stdout || "").trim()));
      console.log("\nTo finish service setup, SSH in directly as this user and run:");
      console.log(c.cyan("  bivy service install"));
      console.log("If it still fails, run once as root:");
      console.log(c.cyan(`  loginctl enable-linger ${username}`));
      return false;
    }
    if (linger.code === 0) {
      console.log(c.dim("Enabled systemd linger so the node keeps running after SSH logout."));
    } else {
      console.log(c.dim(`If the node stops after logout, run as root: loginctl enable-linger ${username}`));
    }
  }
  config.service = true;
  saveConfig(config);
  console.log(c.green(`Background service installed (${kind}).`));
  return true;
}

function uninstallService() {
  const { kind, file } = servicePaths();
  if (kind === "unsupported" || !fs.existsSync(file)) {
    console.log("No background service installed.");
  } else if (kind === "launchd") {
    runQuiet("launchctl", ["unload", file]);
    fs.rmSync(file, { force: true });
    console.log(c.green("launchd service removed."));
  } else {
    runQuiet("systemctl", ["--user", "disable", "--now", SERVICE_UNIT]);
    fs.rmSync(file, { force: true });
    runQuiet("systemctl", ["--user", "daemon-reload"]);
    console.log(c.green("systemd service removed."));
  }
  const config = loadConfig();
  config.service = false;
  saveConfig(config);
}

// Environment `systemctl --user` needs when it is not inherited from a login
// session — e.g. when `bivy` is invoked via the ~/.local/bin symlink or from a
// context where pam_systemd did not export XDG_RUNTIME_DIR. Without this,
// `systemctl --user` fails to reach the user manager.
function systemdUserEnv() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
}

function restartService() {
  const { kind, file } = servicePaths();
  if (!fs.existsSync(file)) return false;
  if (kind === "launchd") {
    runQuiet("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`]);
    // Fallback for older launchctl
    runQuiet("launchctl", ["unload", file]);
    runQuiet("launchctl", ["load", "-w", file]);
    return true;
  }
  if (kind === "systemd") {
    // Report the real outcome: if the user manager can't be reached (no linger,
    // missing XDG_RUNTIME_DIR, etc.) the restart failed and callers should fall
    // back to a foreground/background start instead of waiting on a node that
    // was never (re)started.
    return runQuiet("systemctl", ["--user", "restart", SERVICE_UNIT], { env: systemdUserEnv() }).code === 0;
  }
  return false;
}

// Is `config.port` currently held by *this install's own* node, as opposed to a
// foreign node (a second OS user's, a staging+prod pair) or an unrelated
// process? We ask whoever is listening for its data dir via /api/status and
// compare to ours: our own node reports the same appDir; a foreign bivy node
// reports a different one (or rejects our device token and throws); a non-bivy
// process makes the request throw. Only a match counts as "ours", so port
// reconciliation never relocates a node off a port it legitimately owns.
async function portHeldByOwnNode(config) {
  try {
    const status = await localApi(config, "/api/status");
    return Boolean(status?.appDir) && path.resolve(status.appDir) === path.resolve(appDir);
  } catch {
    return false;
  }
}

// Re-validate the saved node port before it is baked into a service unit or
// restarted into, rolling it forward (and persisting the new value) if a second
// node on this machine has claimed it since setup. An explicit `PORT=…` is
// honored verbatim. Returns true when the port changed, so the caller knows to
// rewrite the unit whose PORT env is now stale. See reconcilePort() for the
// decision rules. Our own running node is never treated as a collision.
async function reconcileNodePort(config) {
  const current = Number(config.port) || 4317;
  const chosen = await reconcilePort(current, nodeBindHost(), {
    explicitPort: Number(process.env.PORT),
    heldByOwnNode: () => portHeldByOwnNode(config),
  });
  if (chosen === current) return false;
  console.log(
    c.yellow(`Port ${current} is already in use by another node on this machine — moving this node to ${chosen}.`),
  );
  config.port = chosen;
  saveConfig(config);
  return true;
}

// Restart the background service, but first make sure the port it will bind is
// still free. If a foreign node grabbed it while ours was down, relocate: the
// unit's baked-in PORT is now stale, so a full reinstall rewrites it (and
// reloads/relaunches). Otherwise a plain restart. Returns true if the service
// was (re)started. Used by `bivy restart` and `bivy update` — the paths that
// previously trusted the saved port verbatim.
async function restartServiceReconciled(config) {
  const { kind, file } = servicePaths();
  if (!fs.existsSync(file)) return restartService();
  const portChanged = await reconcileNodePort(config);
  const expected = kind === "launchd" ? plistContent(config) : kind === "systemd" ? systemdContent(config) : "";
  let configChanged = false;
  try { configChanged = Boolean(expected) && fs.readFileSync(file, "utf8") !== expected; } catch { configChanged = true; }
  // A typed config edit may change workspace, port, or environment without
  // touching the old unit. Reinstall on content drift so `bivy restart` really
  // applies the canonical file instead of reviving stale baked-in values.
  if (portChanged || configChanged) return await installService(config);
  return restartService();
}

// How long a restart triggered by `bivy update`/`bivy restart` will wait for
// in-flight agent turns to finish before restarting anyway. Restarting the
// service SIGTERMs every open session's agent process; done mid-turn that
// kills a running tool call or an in-progress reply outright (issue #474: "bivy
// update kills live sessions and tool use"). So we poll the node's own view of
// which sessions are busy (`/api/status`.sessions.busy, backed by the same
// `sessionBusy` the server uses to protect a session from deletion) and hold
// off restarting until nothing is mid-turn — but only up to a bounded grace
// period, so a wedged session can't block an update forever. Override with
// BIVY_UPDATE_WAIT_TIMEOUT_MS (0 skips waiting entirely).
const UPDATE_WAIT_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes
const UPDATE_WAIT_POLL_MS = 3000;

async function waitForIdleSessions(config, { skip = false } = {}) {
  if (skip) return;
  const envTimeout = Number(process.env.BIVY_UPDATE_WAIT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout >= 0 ? envTimeout : UPDATE_WAIT_DEFAULT_MS;
  if (timeoutMs === 0) return;
  if (!(await isReachable(config))) return; // nothing running — nothing to wait for

  const busyCount = async () => {
    try {
      const status = await localApi(config, "/api/status");
      return Number(status?.sessions?.busy) || 0;
    } catch {
      return 0; // node went away mid-poll — nothing left to wait for
    }
  };

  let busy = await busyCount();
  if (busy <= 0) return;

  const plural = (n) => (n === 1 ? "" : "s");
  console.log(c.dim(`Waiting for ${busy} active agent session${plural(busy)} to finish the current turn before restarting…`));
  const start = Date.now();
  let lastLogged = busy;
  while (busy > 0) {
    if (Date.now() - start > timeoutMs) {
      console.log(c.yellow(`Still ${busy} session${plural(busy)} busy after ${Math.round(timeoutMs / 1000)}s — restarting anyway. Interrupted sessions can be resumed once the node is back.`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, UPDATE_WAIT_POLL_MS));
    busy = await busyCount();
    if (busy !== lastLogged) {
      if (busy > 0) console.log(c.dim(`  ${busy} session${plural(busy)} still busy…`));
      lastLogged = busy;
    }
  }
  console.log(c.dim("All sessions idle — restarting."));
}

// Where a background (non-service) node start sends its stdout/stderr, so a
// crash on startup leaves a trail instead of vanishing into stdio: "ignore".
const nodeLogPath = path.join(appDir, "node.log");

function readTail(file, lines = 30) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
    if (!text) return "";
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// When the node never became reachable, gather whatever the failed start
// actually printed so the user sees the real error instead of a bare
// "Could not start". Pulls from the systemd journal, the launchd log files, or
// the background log depending on how the node was launched.
function printNodeStartupDiagnostics() {
  const { kind, file } = servicePaths();
  let details = "";
  // Only consult service logs when the node was actually launched via the
  // service (its unit/plist exists). Otherwise it came from the background
  // spawn below, whose output we captured to nodeLogPath.
  if (kind === "systemd" && fs.existsSync(file)) {
    const res = runQuiet(
      "journalctl",
      ["--user", "-u", SERVICE_UNIT, "-n", "30", "--no-pager"],
      { env: systemdUserEnv() },
    );
    const out = (res.stdout || res.stderr || "").replace(/\s+$/, "");
    // journalctl prints "-- No entries --" (exit 0) when the unit has no logs.
    if (out && !/^-- No entries --$/.test(out)) details = out;
  } else if (kind === "launchd" && fs.existsSync(file)) {
    details = [readTail("/tmp/bivy.err.log"), readTail("/tmp/bivy.log")].filter(Boolean).join("\n");
  }
  if (!details) details = readTail(nodeLogPath);
  if (details) {
    console.error(c.dim("Recent output from the Bivy node:"));
    console.error(details);
    console.error("");
  }
  console.error(c.yellow("Run 'bivy start' in the foreground to see the full startup error."));
}

function stopService() {
  const { kind, file } = servicePaths();
  if (!fs.existsSync(file)) {
    console.log("No background service installed (nothing to stop).");
    return;
  }
  if (kind === "launchd") {
    runQuiet("launchctl", ["unload", file]);
  } else {
    runQuiet("systemctl", ["--user", "stop", SERVICE_UNIT], { env: systemdUserEnv() });
  }
  console.log(c.green("Node service stopped."));
}

function serviceStatusLine() {
  const { kind, file } = servicePaths();
  if (kind === "unsupported") return "service: unsupported platform";
  if (!fs.existsSync(file)) return "service: not installed";
  if (kind === "systemd") {
    const res = runQuiet("systemctl", ["--user", "is-active", SERVICE_UNIT], { env: systemdUserEnv() });
    return `service: systemd (${res.stdout.trim() || "unknown"})`;
  }
  const res = runQuiet("launchctl", ["list", SERVICE_LABEL]);
  return `service: launchd (${res.code === 0 ? "loaded" : "not loaded"})`;
}

// --- browser ----------------------------------------------------------------

// The daemon writes a per-process bootstrap secret (0600) that the loopback UI
// must present to mint its device token. Read it and append to the open URL so
// the legitimate launcher works while other local users (who can't read the
// file) cannot bootstrap. Falls back to the plain URL if absent.
function openBrowser(target) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  runQuiet(opener, [target]);
}

// Best-effort guess at whether this machine can actually open a browser. macOS
// and Windows always can; a Linux box needs a display server *and* xdg-open.
// Headless servers fail both, so callers can print instructions instead of
// silently spawning an opener that does nothing.
function canOpenBrowser() {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return hasDisplay && commandExists("xdg-open");
}

async function localApi(config, pathName, init = {}) {
  let res;
  try {
    const headers = new Headers(init.headers || {});
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    // Opportunistically attach a device token when the caller didn't set one.
    // Needed once the daemon requires auth even on loopback (multi-user host
    // detection, BIVY_REQUIRE_LOCAL_AUTH=1 — see src/auth.ts); a harmless
    // extra Authorization header otherwise, since the daemon still accepts
    // bare loopback there. Skip for the bootstrap call itself (it authenticates
    // with the bootstrap secret, not a token) to avoid recursing.
    if (!headers.has("authorization") && pathName !== "/api/auth/bootstrap") {
      try {
        headers.set("authorization", `Bearer ${await localDeviceToken(config)}`);
      } catch {
        // No bootstrap secret on disk, node unreachable for bootstrap, etc. —
        // fall back to an unauthenticated call, same as before this existed.
      }
    }
    res = await fetch(`${url(config)}${pathName}`, { ...init, headers });
  } catch (error) {
    throw new Error(`Could not reach the local node at ${url(config)}. Start it with 'bivy start' or 'bivy service install'.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Local node request failed (${res.status})`);
  return data;
}

function readBootstrapSecret() {
  try {
    const { secret } = JSON.parse(fs.readFileSync(path.join(appDir, "bootstrap.json"), "utf8"));
    return typeof secret === "string" ? secret : "";
  } catch {
    return "";
  }
}

// Cached for the lifetime of this CLI process: localApi() above now fetches a
// token opportunistically for every unauthenticated call, and without caching
// that would mint (and register) a brand-new "Bivy CLI" device on each one —
// e.g. once per poll iteration in waitForIdleSessions(). One token is reused
// for the whole invocation.
let cachedDeviceToken = null;

async function localDeviceToken(config) {
  if (cachedDeviceToken) return cachedDeviceToken;
  const secret = readBootstrapSecret();
  if (!secret) throw new Error("The node is running but no bootstrap secret was found. Restart it with 'bivy restart' or 'bivy start'.");
  const data = await localApi(config, "/api/auth/bootstrap", {
    method: "POST",
    headers: { "x-bivy-bootstrap": secret },
    body: JSON.stringify({ name: "Bivy CLI" }),
  });
  if (!data?.token) throw new Error("Local node did not return a device token.");
  cachedDeviceToken = data.token;
  return cachedDeviceToken;
}

function loadRelayConfig() {
  try {
    return JSON.parse(fs.readFileSync(relayConfigPath, "utf8"));
  } catch {
    return null;
  }
}

async function controlPlaneNodeApi(relay, pathName, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${relay.enrollmentToken}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${String(relay.controlPlaneUrl || "").replace(/\/$/, "")}${pathName}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Control-plane request failed (${res.status})`);
  return data;
}

let cachedQr;
function terminalQr(text) {
  try {
    if (!cachedQr) {
      const sandbox = { window: {} };
      vm.runInNewContext(fs.readFileSync(qrEntry, "utf8"), sandbox, { filename: qrEntry });
      cachedQr = sandbox.window.QRCode;
    }
    const M = cachedQr.generate(text);
    const quiet = 2;
    const rows = [];
    for (let r = -quiet; r < M.size + quiet; r += 2) {
      let line = "";
      for (let col = -quiet; col < M.size + quiet; col++) {
        const top = r >= 0 && r < M.size && col >= 0 && col < M.size && M.m[r][col];
        const bottom = r + 1 >= 0 && r + 1 < M.size && col >= 0 && col < M.size && M.m[r + 1][col];
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      }
      rows.push(line);
    }
    return rows.join("\n");
  } catch {
    return "";
  }
}

// --- commands ---------------------------------------------------------------

async function cmdSetup(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy setup\n\nFirst-run wizard: agent choice, model login, remote access + sign-in, and background service. Workspace and port get safe defaults. Re-run later to change the default agent or remote access.");
    return;
  }
  console.log(c.bold("\n  Bivy — node setup\n"));
  if (process.getuid?.() === 0) {
    console.log(c.yellow("You are running setup as root. For a real node, create a normal user (e.g. 'bivy') and install there."));
  }
  if (!(await ensureDeps())) process.exit(1);

  const existingConfig = fs.existsSync(cliConfigPath);
  const config = loadConfig();
  const rl = createPrompter();
  const { ask, askChoice, askYesNo } = rl;

  // 1. Workspace + local port — chosen for the user, no prompts. The workspace
  // defaults to a dedicated ~/bivy-workspace folder that won't collide with the
  // user's own projects; the local port is for this machine only (remote access
  // goes through the relay). Both are changeable later in Settings.
  //
  // Port selection auto-avoids collisions so multiple nodes on one machine (e.g.
  // a staging + production node, or one node per OS user) "just work" without the
  // user picking ports: an explicit `PORT=… bivy setup` is honored verbatim,
  // otherwise we take the first free port at or above 4317. Without this the
  // second node would default to 4317 too and silently fail to bind.
  if (!existingConfig || config.workspace === repoRoot) {
    const workspace = config.workspace !== repoRoot ? config.workspace : path.join(os.homedir(), "bivy-workspace");
    if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
    config.workspace = workspace;
    const explicitPort = Number(process.env.PORT);
    const savedPort = Number(config.port);
    if (explicitPort) {
      config.port = explicitPort;
    } else {
      const preferred = savedPort || 4317;
      config.port = await findAvailablePort(preferred, nodeBindHost());
      if (config.port !== preferred) {
        console.log(c.dim(`Port ${preferred} is already in use (another node?) — using ${config.port} for this node.`));
      }
    }
    saveConfig(config);
  }
  console.log(c.dim(`Workspace: ${config.workspace}  ·  local port: ${config.port}  (change both in Settings)`));

  // 2. Agent first: authentication depends on who owns the selected agent's
  // credentials. Prefer an already-installed native agent on a fresh machine,
  // while retaining the saved choice when setup is re-run.
  console.log(c.bold("\n  Agent\n"));
  const agentChoice = await askChoice(
    "Which agent do you want to try first?",
    SETUP_AGENT_CHOICES.map((choice) => ({
      key: choice.key,
      label: `${choice.label}${choice.command && commandExists(choice.command) ? " (installed)" : ""}`,
    })),
    setupAgentDefaultKey(config),
  );
  const setupAgent = SETUP_AGENT_CHOICES.find((choice) => choice.key === agentChoice) || setupAgentByRuntime("pi");
  if (setupAgent) {
    config.env = { ...config.env, BIVY_RUNTIME: setupAgent.runtimeId };
    saveConfig(config);
    // Keep the daemon's authoritative node setting aligned with the wizard.
    // Without this, a prior Settings choice wins over BIVY_RUNTIME at boot and
    // the app opens a new session on a different agent than the user just chose.
    saveDefaultAgentSetting(setupAgent.runtimeId);
  }
  let agentReady = true;
  if (setupAgent && setupAgent.runtimeId !== "pi") {
    agentReady = await ensureSetupAgent(setupAgent);
    if (!agentReady) console.log(c.yellow(`${setupAgent.label} was not fully installed. Install it later from the app or with 'bivy agents:install'.`));
  }
  console.log(c.dim(`Default agent: ${setupAgent?.label || "Pi"}  (change any time in Settings)`));

  // 3. Secure remote web/PWA access is what makes a Bivy-managed CLI useful:
  // without a relay/control plane it adds nothing over running the agent
  // directly. Setup therefore requires hosted or self-hosted enrollment.
  //
  // Carries the account session from relay:setup to the setup-completion step so
  // we can open the remote app signed into the whole account (see finishSetupRemote).
  let setupSession = null;
  if (!fs.existsSync(relayConfigPath)) {
    console.log(c.bold("\n  Remote access\n"));

    console.log("Bivy uses remote access to make agent sessions visible and steerable from your other devices.");
    // If self-host endpoints are already provided via the environment, default to
    // self-hosted so a scripted or self-hosted install doesn't have to re-pick it
    // (BIVY_CONTROL_PLANE_URL / BIVY_RELAY_URL then pre-fill the URL prompts below).
    const selfHostEnv = Boolean((process.env.BIVY_CONTROL_PLANE_URL || "").trim() || (process.env.BIVY_RELAY_URL || "").trim());
    const syncChoice = await askChoice(
      "Remote access",
      [
        { key: "h", label: "hosted (recommended — first 25 remotely accessible sessions are free; nothing caps your local usage)" },
        { key: "s", label: "self-hosted (your own control plane + relay)" },
      ],
      selfHostEnv ? "s" : "h",
    );
    const relayArgs = [];
    if (syncChoice === "s") {
      const endpoints = await getHostedEndpoints();
      const controlPlane = await ask("  Control plane URL:", process.env.BIVY_CONTROL_PLANE_URL || endpoints.controlPlane);
      const relayWs = await ask("  Relay ws(s):// URL:", process.env.BIVY_RELAY_URL || endpoints.relay);
      if (controlPlane.trim()) relayArgs.push("--control-plane", controlPlane.trim());
      if (relayWs.trim()) relayArgs.push("--relay", relayWs.trim());
    }

    const loginChoice = await askChoice(
      "Remote login",
      [
        { key: "g", label: "GitHub" },
        { key: "e", label: "email sign-in link (open or scan on any device)" },
      ],
      "g",
    );
    if (loginChoice === "e") {
      const email = await ask("  Your account email:", config.env.BIVY_EMAIL || "");
      if (email.trim()) relayArgs.push("--email", email.trim());
      else relayArgs.push("--github");
    } else {
      relayArgs.push("--github");
    }

    const useGithub = relayArgs.includes("--github");
    try { fs.rmSync(setupSessionPath, { force: true }); } catch { /* best effort */ }
    let relayOk;
    for (;;) {
      console.log(c.dim(useGithub
        ? "  We'll open GitHub in your browser (or print the URL on a headless server). Authorize, and setup continues automatically."
        : "  We'll email you a sign-in link. Open it in any browser and setup continues automatically."));
      rl.pause();
      const code = await run(nodeBin, [...nodeScriptArgs(relaySetupEntry), ...relayArgs, "--emit-session", setupSessionPath], {
        cwd: repoRoot,
        env: startEnv(config),
      });
      rl.resume();
      relayOk = code === 0;
      if (relayOk) break;
      const retry = await askYesNo("Remote access setup failed. Try again?", true);
      if (!retry) break;
    }
    if (!relayOk) {
      rl.close();
      console.error(c.red("\nSetup is incomplete: Bivy could not connect this node to a relay/control plane."));
      console.error(`Re-run ${c.cyan("bivy setup")} to retry.`);
      process.exitCode = 1;
      return;
    }
    setupSession = consumeSetupSession();
  } else {
    console.log(c.dim("\nRemote access already configured. Re-run 'bivy relay:setup' to change sync or sign-in."));
  }

  // GitHub App — connect it from the web app (Settings → GitHub App) or with
  // `bivy github:app-create` / `github:app-connect`. One app covers every repo,
  // and the node mints its own tokens, so there's no per-repo token to set up here.

  // Model access is part of activation, not a post-success footnote. Pi/Aider use
  // Bivy's provider login; offer it inline so setup cannot imply the first task
  // is ready while the required credential is still absent. Agent-native auth is
  // explained in the readiness checklist below because those CLIs own the flow.
  let agentAuthReady = setupAgent?.needsBivyModel ? hasModelConfig(config) : nativeAgentAuthDetected(setupAgent);
  if (setupAgent?.needsBivyModel && !agentAuthReady) {
    console.log("\nBivy stores this credential encrypted on your machine, reuses it with compatible agents, and syncs it E2E-encrypted to your other Bivy nodes. Bivy Cloud never receives it in plaintext.");
    const signInNow = await askYesNo("Sign in to a model now so your first task can run?", true);
    if (signInNow) {
      rl.pause();
      const loginCode = await runSetupModelLogin(config);
      rl.resume();
      if (loginCode !== 0 || !hasModelConfig(loadConfig())) {
        console.log(c.yellow("Model sign-in did not complete. The node can start, but an agent reply still requires 'bivy login'."));
      }
      agentAuthReady = hasModelConfig(loadConfig());
    }
  } else if (setupAgent && !setupAgent.needsBivyModel) {
    if (agentAuthReady) {
      const imported = await ingestSetupAgentLogin(setupAgent);
      console.log(c.green(`\n  ✓ Existing ${setupAgent.label} login detected — Bivy will reuse it in the terminal and PWA${imported ? " and stored it in the encrypted vault" : ""}.`));
    } else if (setupAgent.command) {
      console.log(`\n${setupAgent.label} owns its login. After sign-in, Bivy stores compatible credential fields in its encrypted vault so the terminal, PWA, and your other Bivy nodes can reuse them.`);
      const signInNow = await askYesNo(`Open ${setupAgent.label} now to sign in? (Exit it when sign-in is complete.)`, true);
      if (signInNow) {
        rl.pause();
        const loginCode = await run(setupAgent.command, [], { cwd: config.workspace, env: startEnv(config) });
        rl.resume();
        agentAuthReady = loginCode === 0 || nativeAgentAuthDetected(setupAgent);
        if (agentAuthReady) await ingestSetupAgentLogin(setupAgent);
      }
    }
  }

  // Materialize canonical typed config before starting/restarting the daemon,
  // so this setup run's workspace/port/agent choices are effective immediately.
  // Existing config keeps every advanced field.
  await run(nodeBin, [...nodeScriptArgs(configEntry), "migrate", "--from-legacy", "--quiet"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "ignore",
  }).catch(() => {});
  await hydrateCanonicalConfig().catch(() => {});

  // 4. Background service — always installed so the node keeps running (and stays
  // reachable remotely) after you close this terminal. No prompt.
  let started = false;
  if (process.env.BIVY_SETUP_SKIP_SERVICE === "1") {
    // Isolation seam for disposable/container smoke tests: the caller starts a
    // node with this BIVY_DATA_DIR/port and setup exercises the real wizard
    // without installing or replacing the host user's system service.
    started = await isReachable(config);
    console.log(c.dim(`\nBackground-service install skipped; using the isolated node already running at ${url(config)}.`));
  } else if (config.service) {
    console.log(c.dim("\nBackground service already configured; restarting it."));
    started = restartService();
  } else {
    console.log(c.dim("\nInstalling the background service so the node keeps running…"));
    started = await installService(config);
  }
  rl.close();

  if (!started) {
    console.log(c.yellow("\nThe node could not be installed as a background service on this machine."));
    console.log(`Start it in this terminal with ${c.cyan("bivy start")}, or retry the install with ${c.cyan("bivy service install")}.`);
    return;
  }

  const finalConfig = loadConfig();
  const modelReady = setupAgent?.needsBivyModel ? hasModelConfig(finalConfig) : agentAuthReady;
  console.log(c.bold(c.green("\n  ✓ Node running. Check first-task readiness below.\n")));
  console.log(`  ${c.green("✓")} node reachable at ${url(finalConfig)}`);
  console.log(`  ${agentReady ? c.green("✓") : c.yellow("!")} runtime ${agentReady ? `${setupAgent?.label || "Pi"} available` : "not installed — run 'bivy agents:install'"}`);
  console.log(`  ${modelReady ? c.green("✓") : c.yellow("!")} model ${modelReady ? (setupAgent?.needsBivyModel ? "credential configured" : "native agent login ready") : (setupAgent?.needsBivyModel ? "not configured — run 'bivy login'" : `${setupAgent?.loginHint || "sign in through the selected agent"}`)}`);
  console.log(`  ${c.dim("○")} repository chosen from the directory where you start Bivy`);
  const ghReady = githubConnected(finalConfig);
  console.log(`  ${ghReady ? c.green("✓") : c.dim("○")} GitHub ${ghReady ? "connected — your repos will list in the app" : c.dim("optional — connect later in the app under Settings → GitHub App")}`);
  console.log(`  ${agentReady && modelReady ? c.green("✓") : c.yellow("!")} first task ${agentReady && modelReady ? "ready to try" : "blocked by the stage above"}`);
  console.log(`  ${fs.existsSync(relayConfigPath) ? c.green("✓") : c.yellow("!")} remote ${fs.existsSync(relayConfigPath) ? "configured" : "not configured — run 'bivy relay:setup'"}\n`);
  // Get the user into the product immediately; terminal commands are the
  // fallback/next-step checklist after the remote app has been opened or linked.
  await finishSetupRemote(finalConfig, setupSession);
  printFirstRunSteps(modelReady, setupAgent);
}

// Read and delete the one-time account-session handoff written by relay:setup
// (see setupSessionPath). Returns { session, nodeId } or null. Deleting on read
// keeps the account bearer from lingering on disk.
function consumeSetupSession() {
  try {
    const raw = fs.readFileSync(setupSessionPath, "utf8");
    try { fs.rmSync(setupSessionPath, { force: true }); } catch { /* best effort */ }
    const data = JSON.parse(raw);
    return data && typeof data === "object" && data.session ? data : null;
  } catch {
    return null;
  }
}

// Setup completion: point the user at the *remote* app (e.g. https://app.bivy.sh).
// The node is a data plane and no longer hosts a UI, so the web/PWA app always
// comes from the control plane — the same experience from any device, and it
// works from a headless server.
//
// The local browser we open is signed into the user's *account* (using the
// session they just authenticated with during relay:setup), so it lists ALL
// their nodes and pre-selects the one just set up — matching "sign in and see
// every node". Opening a node-scoped link grant instead (as this used to) made
// `/nodes` return only this one node, so a user with other nodes appeared to land
// on a different/empty account until they signed out and back in.
//
// Open this node's REMOTE control-plane app in a local browser (best effort) and
// return the URL involved. The node no longer hosts a UI, so the web/PWA app
// always comes from the hosted or self-hosted control plane. Prefers, in order:
// an account sign-in URL (only available right after `relay:setup`, when a
// setupSession is supplied) → the plain remote base URL, where the user signs
// in normally. Pairing is deliberately reserved for the explicit `bivy link`
// command; ordinary setup/open should establish the full account experience.
// Prints a clean "Opening <base>" line — never the tokenized fragment, so no
// account secret lands in terminal scrollback.
// Returns null when no relay is configured (caller should send the user to
// `bivy relay:setup`).
async function openRemoteApp({ setupSession = null, open = true, remotePath = "" } = {}) {
  const relay = loadRelayConfig();
  if (!relay) return null;

  const remoteBase = String(relay.clientBaseUrl || (await getHostedEndpoints()).clientBaseUrl || "").replace(/\/+$/, "");

  // Account sign-in URL: the fragment carries the account session from
  // relay:setup (so /nodes returns every node) plus this node's id to pre-select
  // it. Same shape the control plane redirects to after a web GitHub sign-in, so
  // the app's consumeLinkPayload folds it in the same way.
  let accountUrl = "";
  if (setupSession?.session && remoteBase) {
    const payload = {
      controlPlane: relay.controlPlaneUrl,
      relay: relay.url,
      session: setupSession.session,
      ...(setupSession.nodeId ? { node: { id: setupSession.nodeId } } : {}),
      // One-shot first-run preference. The browser may already remember an agent
      // from another node; carrying the install choice prevents that stale local
      // preference from replacing what the user selected seconds ago.
      ...(String(loadConfig().env?.BIVY_RUNTIME || "").trim()
        ? { defaultAgent: String(loadConfig().env.BIVY_RUNTIME).trim().toLowerCase() }
        : {}),
    };
    accountUrl = `${remoteBase}${remotePath}/#${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  }

  const openUrl = accountUrl || `${remoteBase}${remotePath}`;
  if (open && canOpenBrowser() && openUrl) {
    console.log(`  Opening ${c.cyan(remoteBase || openUrl)} …`);
    openBrowser(openUrl);
  }
  return { relay, remoteBase, accountUrl, openUrl };
}

// Whether GitHub is connected for repo listing/cloning. Bivy's own connect flow
// (`bivy github:connect`, or the app's Connect button) writes BIVY_GITHUB_TOKEN
// — usually a `secret://` vault reference — into cli.json's env; an explicit env
// token counts too. A `gh auth login` session also works at runtime (the node
// falls back to `gh auth token`), but that can't be known without shelling out,
// so it's treated as "not connected here" — the hint is optional either way.
function githubConnected(config = null) {
  const token = String(
    config?.env?.BIVY_GITHUB_TOKEN || process.env.BIVY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "",
  ).trim();
  return Boolean(token);
}

function printFirstRunSteps(modelReady = false, setupAgent = null) {
  console.log("  Start your first session:");
  if (!modelReady) {
    const login = setupAgent?.needsBivyModel
      ? `${c.cyan("bivy login")}  ${c.dim("(stored in Bivy's encrypted vault)")}`
      : c.cyan(setupAgent?.command || "the selected agent's native CLI");
    console.log(`    Model access: ${login}`);
  }
  const agent = setupAgent?.command || setupAgent?.runtimeId || resolveDefaultAgent();
  const remoteApp = String(loadRelayConfig()?.clientBaseUrl || "https://app.bivy.sh").replace(/\/+$/, "");
  console.log(`    • In the terminal: ${c.cyan(`bivy run ${agent}`)}`);
  console.log(`      Then use the remote app to watch the session or take over in chat.`);
  console.log(`    • Or start in chat: ${c.cyan(remoteApp)}\n`);
}

async function finishSetupRemote(config, setupSession = null) {
  const openable = canOpenBrowser();
  const remote = await openRemoteApp({ setupSession });

  if (!remote) {
    console.log("\n  Almost there — enable remote access to open the Bivy app:");
    console.log(`    • Enable remote:  ${c.cyan("bivy relay:setup")}  (then the app opens automatically)`);
    console.log(`    • Check status:   ${c.cyan("bivy status")}\n`);
    return;
  }

  const { remoteBase } = remote;

  console.log("\n  Access Bivy from anywhere:");
  if (remoteBase) console.log(`    • Remote app:     ${c.cyan(remoteBase)}  (sign in with the same GitHub/email you just used)`);
  console.log(`    • Check status:   ${c.cyan("bivy status")}`);
  if (!openable) {
    console.log(c.dim("\n  No browser on this machine (headless server)? Open the Remote app URL above"));
    console.log(c.dim("  on your phone or laptop and sign in with the same GitHub account or email."));
  }
  console.log("");
}

async function cmdStart(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy start\n\nRun the daemon in the foreground (Ctrl+C to stop). For a persistent background service, see 'bivy service install' or 'bivy setup'.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const config = loadConfig();
  console.log(c.green(`Starting node at ${url(config)} (Ctrl+C to stop)…`));
  const code = await run(nodeBin, nodeScriptArgs(serverEntry), { cwd: repoRoot, env: startEnv(config) });
  process.exit(code);
}

async function cmdStatus(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy status [--json]\n\nShow config and whether the node is reachable. Exits non-zero when the node is down, so it works as a health gate in scripts.");
    return;
  }
  const json = args.includes("--json");
  const config = loadConfig();
  const reachable = await isReachable(config);
  // Non-zero exit when the node is down so `bivy status` works as a health gate
  // in scripts and monitoring.
  if (!reachable) process.exitCode = 1;
  let status = null;
  if (reachable) {
    try { status = await localApi(config, "/api/status"); } catch {}
  }
  if (json) {
    const relayCfgJson = loadRelayConfig();
    console.log(JSON.stringify({
      reachable,
      url: url(config),
      workspace: status?.workspace || config.workspace,
      service: serviceStatusLine(),
      remoteConfigured: Boolean(status?.relay?.configured || relayCfgJson),
      relay: {
        configured: Boolean(status?.relay?.configured || relayCfgJson),
        connected: status?.relay?.connected ?? null,
        app: status?.relay?.controlPlaneUrl || relayCfgJson?.controlPlaneUrl || null,
        relay: status?.relay?.relayUrl || relayCfgJson?.url || null,
        lastError: status?.relay?.lastError || null,
      },
      status,
    }, null, 2));
    return;
  }
  console.log(c.bold("\n  Bivy node\n"));
  console.log(`  url:       ${url(config)}  ${reachable ? c.green("● reachable") : c.dim("○ not reachable")}`);
  if (status?.version) console.log(`  version:   ${status.version}`);
  console.log(`  workspace: ${status?.workspace || config.workspace}`);
  console.log(`  ${serviceStatusLine()}`);
  const relay = loadRelayConfig();
  const relaySt = status?.relay;
  const relayConfigured = Boolean(relaySt?.configured || relay);
  if (!relayConfigured) {
    console.log(`  remote:    ${c.dim("local only")}  ${c.dim("('bivy relay:setup' to enable remote access)")}`);
  } else {
    // The live link state is only knowable when the node is running; if it's
    // down we can say it's configured but not whether it's currently connected.
    let state;
    if (!reachable) state = c.yellow("configured (node not running)");
    else if (relaySt?.connected) state = c.green("● connected");
    else state = c.yellow("○ configured, not connected");
    const relErr = relaySt?.lastError ? c.dim(`  (${relaySt.lastError})`) : "";
    console.log(`  remote:    ${state}${relErr}`);
    const cpUrl = relaySt?.controlPlaneUrl || relay?.controlPlaneUrl;
    const rlUrl = relaySt?.relayUrl || relay?.url;
    if (cpUrl) console.log(`  app:       ${cpUrl}`);
    if (rlUrl) console.log(`  relay:     ${rlUrl}`);
  }
  if (relay?.controlPlaneUrl && relay?.enrollmentToken) {
    try {
      const acct = await controlPlaneNodeApi(relay, "/node/account");
      const planName = { free: "Free", pro: "Pro", individual: "Pro", team: "Team" }[acct?.plan] || acct?.plan || "Free";
      const cap = acct?.entitlements?.maxNodes ?? "∞";
      const nodeLine = `${acct?.counts?.nodes ?? "?"} / ${cap} nodes`;
      const extras = acct?.entitlements?.workQueueEnabled ? "" : c.dim("  (Pro: unlimited nodes, push, GitHub queue)");
      console.log(`  plan:      ${planName}  ·  ${nodeLine}${extras}`);
    } catch {
      // Offline or unenrolled — plan line is best-effort, never blocks status.
    }
  }
  if (status) {
    console.log(`  sessions:  ${status.sessions?.open ?? 0} open, ${status.sessions?.indexed ?? 0} indexed${status.sessions?.active ? `, active ${status.sessions.active}` : ""}`);
    console.log(`  devices:   ${status.devices?.paired ?? 0} paired remote, ${status.devices?.localTokens ?? 0} local token(s)`);
    console.log(`  approvals: ${status.approvals?.pending ?? 0} pending`);
    console.log(`  guard:     ${status.approvalMode || "autonomous"} · ${status.guardrails?.protection || (status.guardrails?.workspaceBoundary ? "structured workspace controls" : "runs with user permissions")}`);
    if (status.updatedAt) {
      const when = new Date(status.updatedAt);
      console.log(`  updated:   ${Number.isNaN(when.getTime()) ? status.updatedAt : when.toLocaleString()}`);
    }
  }
  console.log("");
}

// `bivy doctor` — one health screen: runtime deps, node reachability, model auth,
// remote/relay, and agents on PATH.
// `bivy diagnostics [--out <file>]` — fetch the node's redacted diagnostics
// bundle (versions, health counters, whitelisted config, activation record — no
// secrets/prompts/transcripts) and print it, or write it to a file to attach to a
// support request. See src/diagnostics.ts for exactly what is (and isn't) included.
async function cmdDiagnostics(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log('Usage: bivy diagnostics [--out <file>]\n\nPrint a redacted, shareable diagnostics bundle (no secrets, prompts, transcripts, or repo content). --out writes it to a file instead of stdout.');
    return;
  }
  const config = loadConfig();
  if (!(await ensureNodeRunning(config))) { console.error(c.red(`Could not reach the Bivy node at ${url(config)}.`)); process.exit(1); return; }
  let report;
  try { report = await localApi(config, "/api/diagnostics"); }
  catch (error) { console.error(c.red(`Could not fetch diagnostics: ${error?.message || String(error)}`)); process.exit(1); return; }
  const json = JSON.stringify(report, null, 2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 && outIdx + 1 < args.length ? args[outIdx + 1] : undefined;
  if (out) {
    fs.writeFileSync(out, json + "\n");
    console.log(c.green(`Wrote redacted diagnostics to ${out}`));
  } else {
    console.log(json);
  }
}

async function cmdDoctor(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy doctor\n\nHealth check: runtime deps, node reachability, model auth, remote/relay, and agents on PATH. Exits non-zero if Node is unsupported or the node is unreachable, so it can gate CI/monitoring. See also 'bivy diagnostics' for a shareable redacted bundle.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);

  const config = loadConfig();
  const reachable = await isReachable(config);
  let status = null;
  let runtimes = null;
  if (reachable) {
    try { status = await localApi(config, "/api/status"); } catch {}
    try { runtimes = await localApi(config, "/api/runtimes"); } catch {}
  }

  const ok = c.green("✓");
  const bad = c.red("✗");
  const warn = c.yellow("!");
  const mark = (good, soft = false) => (good ? ok : soft ? warn : bad);

  console.log(c.bold("\n  Bivy doctor\n"));
  console.log(`  ${mark(hasSupportedNode())} Node ${process.version}${hasSupportedNode() ? "" : c.dim("  (needs >= 22.19.0)")}`);
  console.log(`  ${mark(commandExists("git"), true)} git${commandExists("git") ? "" : c.dim("  (recommended for repo-backed sessions)")}`);
  // GitHub is optional (a "No repo" session needs none), so this only ever warns.
  // `gh` is NOT required — it's a token fallback; the primary path is Bivy's own
  // 'bivy github:connect' (or the app's Connect button). We surface gh only as an
  // available shortcut when it's installed but nothing is connected yet.
  const ghConnected = githubConnected(config);
  const ghHint = ghConnected
    ? c.green("connected")
    : commandExists("gh")
      ? c.dim("not connected — 'bivy github:connect' (or 'gh auth login')")
      : c.dim("not connected — 'bivy github:connect' to list/clone private repos");
  console.log(`  ${mark(ghConnected, true)} GitHub ${ghHint}`);
  console.log(`  ${mark(reachable)} node ${reachable ? c.green("reachable") : c.dim("not reachable — 'bivy start'")} at ${url(config)}`);
  console.log(`  ${mark(/running/.test(serviceStatusLine()), true)} ${serviceStatusLine()}`);
  const defaultAgent = String(config.env?.BIVY_RUNTIME || runtimes?.current?.id || "pi");
  const runtimeInfo = Array.isArray(runtimes?.runtimes) ? runtimes.runtimes.find((r) => r?.id === defaultAgent) : null;
  const agentAvailable = runtimeInfo ? runtimeInfo.status === "available" : defaultAgent === "pi";
  const setupAgent = setupAgentByRuntime(defaultAgent);
  const authOwner = runtimeInfo?.authOwner || (setupAgent?.needsBivyModel ? "bivy" : "agent");
  console.log(`  ${mark(agentAvailable, true)} agent ${runtimeInfo?.displayName || defaultAgent}${agentAvailable ? "" : c.dim(" not available — install it or run 'bivy setup'")}`);
  console.log(`  ${mark(hasModelConfig(config), authOwner !== "bivy")} model ${hasModelConfig(config) ? "configured" : authOwner === "bivy" ? c.dim("not configured — run 'bivy login'") : c.dim("agent-native auth — use the agent's CLI login if needed")}`);
  const relayConfigured = Boolean(status?.relay?.configured || fs.existsSync(relayConfigPath));
  const relayConnected = Boolean(status?.relay?.connected);
  const relayApp = status?.relay?.controlPlaneUrl;
  const relayErr = status?.relay?.lastError;
  const relayLine = !relayConfigured
    ? c.dim("local only — 'bivy relay:setup' to enable")
    : relayConnected
      ? c.green("relay connected") + (relayApp ? c.dim(`  ${relayApp}`) : "")
      : c.yellow("configured, not connected") + (relayErr ? c.dim(`  (${relayErr})`) : "");
  console.log(`  ${relayConfigured ? (relayConnected ? ok : warn) : c.dim("○")} remote ${relayLine}`);
  // Derived from BUILTIN_TERMINAL_AGENTS (the same list 'bivy agents'/'bivy run'
  // use) rather than a hand-maintained list, so it can't drift out of sync (#113).
  const agentCommands = [...BUILTIN_TERMINAL_AGENTS.values()].filter((a) => a.type === "command").map((a) => a.command);
  const agents = agentCommands.filter((a) => commandExists(a));
  console.log(`  ${mark(agents.length > 0, true)} agents on PATH: ${agents.length ? c.cyan(agents.join(", ")) : c.dim("none (built-in Pi still works; 'bivy agents:install')")}`);
  if (status?.eventLog) {
    const healthy = status.eventLog.ok !== false;
    const mib = Number(status.eventLog.bytes || 0) / (1024 * 1024);
    console.log(`  ${mark(healthy, true)} event log ${healthy ? "writable" : `${status.eventLog.affectedSessions ?? 0} session(s) need attention`} · ${mib.toFixed(1)} MiB`);
  }
  if (status?.attachments) {
    const mib = Number(status.attachments.bytes || 0) / (1024 * 1024);
    const over = Number(status.attachments.overCapBytes || 0);
    console.log(`  ${over > 0 ? warn : ok} attachments ${status.attachments.blobs ?? 0} blob(s), ${mib.toFixed(1)} MiB${over > 0 ? c.dim("  (over cap; referenced history retained)") : ""}`);
  }
  console.log("");

  // Fail the command when a hard check is red (unsupported Node or an
  // unreachable node), so `bivy doctor` is usable as a CI/monitoring gate.
  // Soft checks (git, service, model, agents) only warn.
  if (!hasSupportedNode() || !reachable) process.exitCode = 1;
}

// `bivy logs [-f] [-n N]` — tail the node's output, wherever it lands: the
// systemd journal (Linux service), the launchd log files (macOS service), or the
// background node.log captured by `bivy start`.
async function cmdLogs(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy logs [-f|--follow] [-n|--lines N]\n\nTail the node logs (systemd journal, launchd, or the background log from 'bivy start').");
    return;
  }
  const follow = args.includes("-f") || args.includes("--follow");
  const nArg = argValue(args, "lines") || argValue(args, "n");
  const lines = Number(nArg) > 0 ? String(Math.floor(Number(nArg))) : "80";
  const { kind, file } = servicePaths();

  if (kind === "systemd" && fs.existsSync(file)) {
    const jargs = ["--user", "-u", SERVICE_UNIT, "-n", lines, "--no-pager"];
    if (follow) jargs.push("-f");
    await run("journalctl", jargs, { env: systemdUserEnv() });
    return;
  }
  if (kind === "launchd" && fs.existsSync(file)) {
    await tailFiles(["/tmp/bivy.log", "/tmp/bivy.err.log"], lines, follow);
    return;
  }
  if (fs.existsSync(nodeLogPath)) {
    await tailFiles([nodeLogPath], lines, follow);
    return;
  }
  console.log(c.yellow("No node logs found yet. Start the node with 'bivy start' or 'bivy service install'."));
}

// Tail one or more log files, optionally following. Uses `tail` when present
// (handles -f and multiple files); falls back to a one-shot readTail otherwise.
async function tailFiles(files, lines, follow) {
  const present = files.filter((f) => fs.existsSync(f));
  if (present.length === 0) { console.log(c.dim("No log output yet.")); return; }
  if (commandExists("tail")) {
    const tailArgs = ["-n", lines, ...(follow ? ["-f"] : []), ...present];
    await run("tail", tailArgs);
    return;
  }
  for (const f of present) {
    if (present.length > 1) console.log(c.dim(`==> ${f} <==`));
    console.log(readTail(f, Number(lines)));
  }
  if (follow) console.log(c.dim("(install 'tail' to follow logs live)"));
}

// Stream only this update's portion of update.log while the detached process is
// alive. Keeping stdout pointed directly at the log lets the update survive the
// node restart; polling it here still gives the web terminal live progress up to
// the moment its PTY disappears.
async function showDetachedUpdateProgress(child, start) {
  let offset = start;
  let finished = false;
  let spawnError = null;
  const decoder = new StringDecoder("utf8");
  child.once("exit", () => { finished = true; });
  child.once("error", (error) => {
    spawnError = error;
    finished = true;
  });

  const copyNewOutput = () => {
    const fd = fs.openSync(updateLogPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      process.stdout.write(decoder.write(buf));
    } finally {
      fs.closeSync(fd);
    }
  };

  while (!finished) {
    copyNewOutput();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  copyNewOutput();
  const remainder = decoder.end();
  if (remainder) process.stdout.write(remainder);
  if (spawnError) console.error(c.red(`Could not start update: ${spawnError.message}`));
}

async function cmdUpdate(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy update [--force|--no-wait] [--staging|--stable|--channel <name>]\n\nUpdate Bivy + install deps + restart service. Stays on the release channel recorded at install time (default 'latest'); --staging/--stable/--channel switch channels and are remembered for future updates. Waits for active sessions to finish a turn first; --force/--no-wait skips the wait. See 'bivy update:log' for the last run's output.");
    return;
  }
  // Inside a Bivy web/PWA terminal the shell is a child of the node's own
  // process, so `restartService()` — the final step of an update — tears down
  // this very terminal. Run inline and you lose all output the moment it lands.
  // Instead, re-exec the update as a detached background process that outlives
  // the restart, logging to update.log. Mirror that log into this terminal while
  // the node is still alive; the web client reconnects automatically after the
  // restart, and `bivy update:log` remains available for the final output.
  // Outside a Bivy terminal (a normal shell, where the restart can't kill us) we
  // keep the simple inline flow.
  if (process.env.BIVY_TERMINAL === "1" && process.env.BIVY_UPDATE_DETACHED !== "1") {
    fs.mkdirSync(appDir, { recursive: true });
    const logFd = fs.openSync(updateLogPath, "a");
    const logStart = fs.fstatSync(logFd).size;
    fs.writeSync(logFd, `\n=== bivy update started ${new Date().toISOString()} ===\n`);
    const child = spawn(nodeBin, [selfScript, "update", ...args], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, BIVY_UPDATE_DETACHED: "1" },
    });
    child.unref();
    fs.closeSync(logFd);
    console.log(c.green("Update started in the background. Showing progress until the node restarts…"));
    console.log(c.dim(`The terminal will reconnect automatically. Run ${c.cyan("bivy update:log")} afterward for the final output.`));
    await showDetachedUpdateProgress(child, logStart);
    return;
  }
  await runUpdate(args);
}

async function runUpdate(args = []) {
  const skipWait = args.includes("--force") || args.includes("--no-wait");
  const kind = detectInstallKind();

  if (kind === "npx") {
    console.log(c.dim("This is an ephemeral 'npx bivy' run."));
    console.log(`${c.cyan("npx bivy")} always fetches the latest published version, so there is nothing to update.`);
    console.log(`To install a persistent copy you can manage: ${c.cyan("npm i -g @bivy/bivy")}`);
    return;
  }

  // Update along the recorded channel (default `latest`), not a hardcoded tag,
  // so a staging box stays on staging instead of silently jumping to production.
  const channel = resolveUpdateChannel(args);

  if (kind === "npm-global") {
    console.log(c.dim(`Updating the globally-installed bivy package (channel: ${channel})…`));
    const code = await run("npm", ["install", "-g", `@bivy/bivy@${channel}`, "--no-audit", "--no-fund"]);
    if (code !== 0) {
      console.log(c.yellow(`npm reported an issue (exit ${code}). Try: sudo npm i -g @bivy/bivy@${channel}`));
      process.exit(code);
    }
    await ensureBundledAgents();
    const config = loadConfig();
    await waitForIdleSessions(config, { skip: skipWait });
    if (config.service && (await restartServiceReconciled(config))) {
      console.log(c.green("Updated and restarted the background service."));
    } else {
      console.log(c.green("Updated. Run 'bivy start' (or restart your service) to apply."));
    }
    console.log(c.dim(`=== bivy update finished ${new Date().toISOString()} ===`));
    return;
  }

  if (kind === "packaged") {
    console.log(c.dim(`Updating packaged Bivy install (channel: ${channel})…`));
    // The actual restart happens inside install.sh, which shells out to
    // `bivy restart` (using the freshly-swapped binary) once the new code is in
    // place — that invocation waits for busy sessions on its own. This earlier
    // wait just avoids kicking off the download/swap while a turn is running,
    // so the window between "update starts" and "restart happens" doesn't
    // surprise anyone mid-turn.
    const config = loadConfig();
    await waitForIdleSessions(config, { skip: skipWait });
    // install.sh reads BIVY_CHANNEL from the env; pass the recorded channel so a
    // packaged re-install stays on it (and re-records it) instead of latest.
    const code = await run("bash", ["-c", "curl -fsSL https://bivy.sh/install.sh | bash"], {
      cwd: repoRoot,
      env: { ...process.env, BIVY_HOME: repoRoot, BIVY_CHANNEL: channel },
    });
    process.exit(code);
  }

  console.log(c.dim("Pulling latest code…"));
  const branch = runQuiet("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }).stdout.trim();
  const pull = await run("git", ["pull", "--ff-only", "origin", branch || "main"], { cwd: repoRoot });
  if (pull !== 0) console.log(c.yellow("git pull reported an issue; continuing."));
  await run("npm", [fs.existsSync(path.join(repoRoot, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: repoRoot });
  await ensureBundledAgents();
  const config = loadConfig();
  await waitForIdleSessions(config, { skip: skipWait });
  if (config.service && (await restartServiceReconciled(config))) {
    console.log(c.green("Updated and restarted the background service."));
  } else {
    console.log(c.green("Updated. Run 'bivy start' (or restart your service) to apply."));
  }
  console.log(c.dim(`=== bivy update finished ${new Date().toISOString()} ===`));
}

// Print the update log (default: the tail; `-f`/`--follow` streams new output).
// After a `bivy update` detaches and this terminal reconnects, this is how you
// confirm the background update succeeded.
function cmdUpdateLog(args) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy update:log [-f|--follow]\n\nShow output of the last (or in-progress) 'bivy update' run.");
    return;
  }
  if (!fs.existsSync(updateLogPath)) {
    console.log(c.dim("No update log yet — run 'bivy update' first."));
    return;
  }
  const TAIL_BYTES = 64 * 1024;
  const readFrom = (start) => {
    const fd = fs.openSync(updateLogPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= start) return { text: "", end: size };
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString("utf8"), end: size };
    } finally {
      fs.closeSync(fd);
    }
  };

  const size = fs.statSync(updateLogPath).size;
  const first = readFrom(Math.max(0, size - TAIL_BYTES));
  process.stdout.write(first.text);

  if (!(args.includes("-f") || args.includes("--follow"))) return;
  console.log(c.dim("\n— following (Ctrl-C to stop) —"));
  let offset = first.end;
  fs.watchFile(updateLogPath, { interval: 500 }, (cur) => {
    if (cur.size < offset) offset = 0; // rotated/truncated
    if (cur.size > offset) {
      const next = readFrom(offset);
      process.stdout.write(next.text);
      offset = next.end;
    }
  });
}

async function cmdLogin(args) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy login [provider]\n\nSign into a model provider (Pi's native /login). With no provider, prompts interactively for the auth method and provider.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const config = loadConfig();
  const code = await run(nodeBin, [...nodeScriptArgs(bivyLoginEntry), ...args], {
    cwd: repoRoot,
    env: startEnv(config),
  });
  process.exit(code);
}

async function cmdLinkPhone(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy link\n\nShow a remote web/PWA link (and QR) in the terminal, single-use and short-lived (5 minutes). Requires 'bivy relay:setup' first.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const config = loadConfig();
  if (!(await isReachable(config))) {
    console.log(c.yellow(`The node is not reachable at ${url(config)}.`));
    if (config.service) console.log(`Try: ${c.cyan("bivy restart")} then ${c.cyan("bivy link")}`);
    else console.log(`Try: ${c.cyan("bivy start")} in another terminal, then ${c.cyan("bivy link")}`);
    return;
  }
  try {
    const token = await localDeviceToken(config);
    const data = await localApi(config, "/api/relay/link", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    if (!data?.url) throw new Error("The node did not return a link URL.");
    console.log(c.bold(c.green("\n  Link remote web/PWA\n")));
    const qr = terminalQr(data.url);
    if (qr) console.log(qr);
    console.log(`\nOpen or scan this link with the Bivy remote web/PWA:\n${c.cyan(data.url)}\n`);
  } catch (error) {
    console.error(c.red(error instanceof Error ? error.message : String(error)));
    console.log(c.dim("If hosted relay is not configured yet, run 'bivy relay:setup' first."));
  }
}

function printUninstallHelp() {
  console.log(`
${c.bold("bivy uninstall")} — remove Bivy and all its data from this machine

  ${c.cyan("bivy uninstall")}                 Remove everything (asks first)
  ${c.cyan("bivy uninstall -y")}              Skip the confirmation prompt
  ${c.cyan("bivy uninstall --keep-sessions")}   Keep sessions, picked back up on your next install
  ${c.cyan("bivy uninstall --keep-worktrees")}  Leave the git worktrees in your repos untouched
  ${c.cyan("bivy uninstall --dry-run")}       Show what would be removed, delete nothing

  Removes the background service, the running node, the CLI symlink, the app
  install, and all local state — config, credentials, session transcripts, and
  --clone workspaces — plus the git worktrees Bivy created in your repos. A
  source (git) checkout keeps its code; only the .bivy state dir is removed.
`);
}

// `bivy uninstall` — remove Bivy from this machine: stop and delete the
// background service, kill the running node, drop the CLI symlink, and delete
// the app install plus all local state (config, credentials, session
// transcripts, --clone workspaces) and the git worktrees Bivy created in your
// repos. Deletes everything by default; --keep-sessions / --keep-worktrees opt
// those out, --dry-run previews, and -y skips the prompt.
async function cmdUninstall(args = []) {
  if (args.includes("-h") || args.includes("--help")) { printUninstallHelp(); return; }
  const yes = args.includes("-y") || args.includes("--yes");
  const dryRun = args.includes("--dry-run");
  const keepSessions = args.includes("--keep-sessions");
  const keepWorktrees = args.includes("--keep-worktrees");

  const config = loadConfig();
  // A source checkout (has .git) keeps its code; we only remove the .bivy state
  // dir. A packaged install (no .git) is disposable, so the whole app dir goes.
  const isGitCheckout = fs.existsSync(path.join(repoRoot, ".git"));
  const symlink = path.join(os.homedir(), ".local", "bin", "bivy");
  const sessionsDir = path.join(appDir, "pi", "sessions");
  // The durable, Bivy-scoped session index (src/metadata.ts) — listAllSessions
  // unions it in for every session a runtime's own listing forgot (closed
  // sessions, a session started from the PWA, etc.) and backfills names/branch/
  // PR info. Without keeping this too, --keep-sessions preserves raw pi
  // transcripts but the CLI and React app still show nothing after reinstall.
  const metadataPath = path.join(appDir, "metadata.json");

  // Git worktrees Bivy created live in your repos (*/.bivy/worktrees), not in the
  // app dir, so they must be found and removed explicitly (and their git
  // registration pruned). Scan the data dir and the configured workspace.
  const worktrees = keepWorktrees
    ? []
    : findWorktreeRoots([appDir, config.workspace].filter(Boolean)).flatMap((r) => pruneListEntries(r, "dir"));
  const sessionCount = keepSessions ? 0 : pruneListEntries(sessionsDir, "any").length;

  console.log(c.bold("\n  bivy uninstall") + c.dim(dryRun ? "  (dry run — nothing will be removed)\n" : "\n"));
  console.log(`  ${serviceStatusLine()}`);
  console.log(`  install:   ${isGitCheckout ? `${repoRoot} ${c.dim("(git checkout — source kept, .bivy state removed)")}` : repoRoot}`);
  console.log(`  state:     ${appDir}`);
  console.log(`  workspace: ${config.workspace || c.dim("(none)")} ${c.dim("(scanned for worktrees; the folder itself is kept)")}`);
  console.log(`  sessions:  ${keepSessions ? c.green("kept") : c.yellow(`${sessionCount}`) + " to remove"}`);
  console.log(`  worktrees: ${keepWorktrees ? c.green("kept") : c.yellow(`${worktrees.length}`) + " to remove"}`);
  if (fs.existsSync(symlink)) console.log(`  cli link:  ${symlink}`);
  console.log("");

  if (dryRun) {
    console.log(c.dim("Dry run: nothing was removed. Re-run without --dry-run to uninstall."));
    return;
  }

  const rl = createPrompter();
  try {
    if (!yes) {
      const ok = await rl.askYesNo("Uninstall Bivy and delete the above? This cannot be undone.", false);
      if (!ok) { console.log(c.dim("Cancelled.")); return; }
    }

    // Remove this node from your Bivy account (hosted control plane).
    if (fs.existsSync(relayConfigPath) && (yes || await rl.askYesNo("Remove this node from your Bivy account too?", true))) {
      try {
        const relayConfig = JSON.parse(fs.readFileSync(relayConfigPath, "utf8"));
        if (relayConfig.controlPlaneUrl && relayConfig.enrollmentToken) {
          const res = await fetch(`${String(relayConfig.controlPlaneUrl).replace(/\/$/, "")}/node`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${relayConfig.enrollmentToken}` },
          });
          console.log(res.ok ? c.green("Removed hosted node registration.") : c.yellow(`Could not remove hosted node registration (${res.status}).`));
        }
      } catch (error) {
        console.log(c.yellow(`Could not remove hosted node registration: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    // Stop and remove the background service, then kill any node still running.
    uninstallService();
    runQuiet("pkill", ["-f", serverEntry]);
    runQuiet("pkill", ["-f", path.join(repoRoot, "dist/server.js")]);

    // Remove the git worktrees Bivy created in your repos, then drop their now
    // dangling git registration (mirrors `bivy prune`).
    if (worktrees.length) {
      const touchedRepos = new Set();
      let removed = 0;
      for (const w of worktrees) {
        try {
          fs.rmSync(w.path, { recursive: true, force: true });
          removed++;
          touchedRepos.add(path.dirname(path.dirname(path.dirname(w.path))));
        } catch (error) {
          console.log(c.yellow(`  could not remove worktree ${w.path}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (commandExists("git")) for (const repo of touchedRepos) runQuiet("git", ["-C", repo, "worktree", "prune"]);
      console.log(c.green(`Removed ${removed} worktree(s).`));
    }

    // Delete all local state and, for a packaged install, the package itself.
    // npm-global installs keep state outside repoRoot (normally ~/.bivy), while
    // tarball installs keep it below repoRoot; removeInstallAndState handles
    // both layouts. With --keep-sessions, the transcripts and session index
    // remain in place while config, credentials, relay enrollment, etc. go.
    const keepPaths = keepSessions ? [sessionsDir, metadataPath].filter((p) => fs.existsSync(p)) : [];
    removeInstallAndState(repoRoot, appDir, { keepInstall: isGitCheckout, keepState: keepPaths });
    fs.rmSync(symlink, { force: true });

    console.log(c.green("\nBivy uninstalled from this machine."));
    if (keepSessions) console.log(c.dim("Your sessions were left in place and will be picked back up the next time Bivy is installed here."));
    if (keepWorktrees) console.log(c.dim("Your git worktrees were left untouched."));
    if (isGitCheckout) console.log(c.dim(`Source checkout kept at ${repoRoot} — remove it manually if you no longer need it.`));
  } finally {
    rl.close();
  }
}

async function cmdRelaySetup(args) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy relay:setup [--email <email>|--github] [--session-token <token>]\n\nEnable secure remote web/PWA access (sign in once). With no flags, prompts interactively for GitHub or email sign-in.");
    return;
  }
  if (!(await ensureDeps())) process.exit(1);
  const config = loadConfig();
  let passthrough = args;
  if (!args.includes("--email") && !args.includes("--session-token") && !args.includes("--github")) {
    const rl = createPrompter();
    const useGithub = await rl.askYesNo("Sign in with GitHub?", true);
    if (useGithub) {
      passthrough = [...args, "--github"];
    } else {
      const email = await rl.ask("Your account email:", config.env.BIVY_EMAIL || "");
      if (!email) {
        rl.close();
        console.log(c.yellow("No email provided; nothing to do."));
        return;
      }
      passthrough = [...args, "--email", email];
    }
    rl.close();
  }
  const code = await run(nodeBin, [...nodeScriptArgs(relaySetupEntry), ...passthrough], {
    cwd: repoRoot,
    env: startEnv(config),
  });
  if (code !== 0) process.exit(code);

  if (restartService()) {
    console.log(c.green("Service restarted with relay enabled."));
    return;
  }

  if (await isReachable(config)) {
    try {
      const token = await localDeviceToken(config);
      await localApi(config, "/api/relay/reload", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      console.log(c.green("Running node reloaded relay config; no restart needed."));
      return;
    } catch (error) {
      console.log(c.yellow(`Could not hot-reload the running node: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  console.log(c.yellow("Relay is configured. Start the node with 'bivy start' to connect."));
}

async function cmdService(args) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bivy service <install|uninstall|status>\n\nManage the background service (systemd on Linux, launchd on macOS) that keeps the node running across reboots.");
    return;
  }
  const action = args[0];
  if (action === "install") {
    if (!(await ensureDeps())) process.exit(1);
    await installService(loadConfig());
  } else if (action === "uninstall" || action === "remove") {
    uninstallService();
  } else if (action === "status") {
    console.log(serviceStatusLine());
  } else {
    console.error(c.red(`${action ? `Unknown service action: ${action}. ` : ""}Usage: bivy service <install|uninstall|status>`));
    process.exit(1);
  }
}

// Read this CLI's version from the shipped package.json. Best-effort: a missing
// or malformed manifest should never crash `bivy --version`.
function readSelfVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp() {
  console.log(`
${c.bold("bivy")} — Bivy node CLI

  ${c.cyan("bivy run claude")}   Run a native agent (real CLI/TUI) as a relay-visible session
  ${c.cyan("bivy run <agent>")}  ${[...BUILTIN_TERMINAL_AGENTS.keys()].join(" | ")} | -- <command>
  ${c.cyan("bivy run <agent> --name <label>")}  Name the session (shown in 'bivy sessions' and the app)
  ${c.cyan("bivy run <agent> --model <model>")}  Run with a specific model (passed to the agent, shown in the cockpit)
  ${c.cyan("bivy run <agent> --node <name>")}  Start the session on another registered node
  ${c.cyan("bivy run <agent> --clone [remote]")}  Start in a fresh clone (current repo, or a given remote)
  ${c.cyan("bivy run <agent> --workspace <dir>")}  Start in an existing directory (default: current repo, else the configured workspace)
  ${c.cyan("bivy rename <name>")}  Rename this node (takes effect immediately, no restart)
  ${c.cyan("bivy nodes")}       List/add/remove other nodes (add <name> <url> --token <t>)
  ${c.cyan("bivy agents")}      List the supported agents and which are installed (--json)
  ${c.cyan("bivy shim install <agent>")}  Make interactive '<agent>' launch its native TUI in a Bivy PTY (remote-visible)
  ${c.cyan("bivy shim")}        List installed agent shims (install/uninstall/status)
  ${c.cyan("bivy takeover <id>")}  Stop a pinned run-terminal's native TUI and continue it as a governed chat
  ${c.cyan("bivy token")}       Print a device token for this node (for 'bivy nodes add' elsewhere)
  ${c.cyan("bivy sessions")}     List recent sessions (live + saved) and resume one (alias: ls)
  ${c.cyan("bivy resume")} [n|id] Resume a session directly (default: most recent)
  ${c.cyan("bivy send <id>")} "..."  Send a prompt to an existing session and stream the reply
  ${c.cyan("bivy kill <id>")}    Stop a session/terminal (--delete also removes a saved session)
  ${c.cyan("bivy prune")}         Delete old sessions/workspaces/worktrees (--keep N, --older-than 7d, --dry-run)
  ${c.cyan("bivy exec")} "<prompt>"  One-shot headless run: prints the answer to stdout (pipe-friendly)
  ${c.cyan("bivy automation")}  init | validate | plan | test | apply (automations as code)
  ${c.cyan("bivy config")}      init | validate | show | get | set | explain (typed node config)
  ${c.cyan("bivy plugin")}      init | validate | doctor | test | install | list | remove
  ${c.cyan("bivy")}              Show this help
  ${c.cyan("bivy setup")}      First-run wizard: agent, model login, remote sign-in, background service
  ${c.cyan("bivy start")}      Run the daemon in the foreground
  ${c.cyan("bivy stop")}       Stop the background service
  ${c.cyan("bivy restart")}    Restart the background service (waits for active sessions to finish a turn; --force to skip)
  ${c.cyan("bivy status")}     Show config and whether the node is reachable
  ${c.cyan("bivy doctor")}     Health check: deps, node, model, remote, agents
  ${c.cyan("bivy logs")} [-f]   Tail the node logs (systemd journal, launchd, or background log)
  ${c.cyan("bivy login")}      Sign into a model provider (Pi /login)
  ${c.cyan("bivy update")}     Update Bivy + install deps + restart service (waits for active sessions to finish a turn; --force to skip)
  ${c.cyan("bivy update:log")} Show output of the last (or in-progress) update
  ${c.cyan("bivy agents:install")}  Install bundled agents (${BUNDLED_AGENTS.map((a) => a.label).join(", ")})
  ${c.cyan("bivy open")}       Open the remote web/PWA app
  ${c.cyan("bivy service")}    install | uninstall | status
  ${c.cyan("bivy uninstall")}    Remove Bivy and all its data (--keep-sessions, --keep-worktrees, --dry-run)
  ${c.cyan("bivy link")}       Show a remote web/PWA link QR in the terminal
  ${c.cyan("bivy relay:setup")}  Enable secure remote web/PWA access (sign in once)
  ${c.cyan("bivy github:app-create")}            One-click: create + connect a GitHub App
  ${c.cyan("bivy github:app-connect")}           Connect an existing GitHub App (--app-id --key)
  ${c.cyan("bivy github:app-sync")} [on|off]     Sync connected GitHub App keys to this account's other opted-in nodes
  ${c.cyan("bivy github:connect")} [owner/repo]  Connect GitHub in the app (or use a configured self-hosted device flow)
  ${c.cyan("bivy secrets")}    list | set | ref | delete | doctor | resolve
  ${c.cyan("bivy voice")}      Configure speech-to-text: provider | key | remove | status
  ${c.cyan("bivy completions")} <bash|zsh|fish>  Print a shell completion script
  ${c.cyan("bivy version")}    Print the installed Bivy version (alias: --version, -v)
`);
}

async function main() {
  await hydrateCanonicalConfig();
  const argv = process.argv.slice(2);
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
      printHelp();
      break;
    case "setup":
    case "init":
      await cmdSetup(args);
      break;
    case "start":
    case "dev":
      await cmdStart(args);
      break;
    case "run":
      // Only intercept bivy's own '--help'/'-h', and only when no agent was given
      // ('bivy run --help'/'bivy run -h'). Once an agent is named the rest of the
      // args (including its own --help) pass straight through to it — e.g.
      // 'bivy run claude --help' must show Claude's help, not bivy's.
      if (args[0] === "-h" || args[0] === "--help") {
        console.log(`Usage: bivy run <agent> [--name <label>] [--model <model>] [--node <name>] [--clone [remote]] [--workspace <dir>] | -- <command>

Run a native agent (real CLI/TUI) as a relay-visible session.
Agents: ${[...BUILTIN_TERMINAL_AGENTS.keys()].join(", ")}, or -- <command> for anything else.
An agent's own --help passes through, e.g. 'bivy run claude --help'.`);
        break;
      }
      await cmdRun(args);
      break;
    case "sessions":
    case "ls":
      await cmdSessions(args);
      break;
    case "resume":
      await cmdSessions(args, { autoResume: true });
      break;
    case "promote":
      await cmdPromote(args);
      break;
    case "rename":
    case "node:rename":
      await cmdRename(args);
      break;
    case "nodes":
      await cmdNodes(args);
      break;
    case "agents":
      cmdAgents(args);
      break;
    case "shim":
    case "listen":
      await cmdShim(args);
      break;
    case "takeover":
      await cmdTakeover(args);
      break;
    case "token":
      await cmdToken(args);
      break;
    case "exec":
      await cmdExec(args);
      break;
    case "kill":
      await cmdKill(args);
      break;
    case "prune":
    case "clean":
      await cmdPrune(args);
      break;
    case "send":
      await cmdSend(args);
      break;
    case "attach":
      await cmdAttach(args);
      break;
    case "completions":
    case "completion":
      cmdCompletions(args);
      break;
    case "automation":
    case "automations": {
      if (!(await ensureDeps())) process.exit(1);
      process.exit(await run(nodeBin, [...nodeScriptArgs(automationEntry), ...args], { cwd: process.cwd(), env: process.env }));
      break;
    }
    case "config": {
      if (!(await ensureDeps())) process.exit(1);
      process.exit(await run(nodeBin, [...nodeScriptArgs(configEntry), ...args], { cwd: process.cwd(), env: process.env }));
      break;
    }
    case "plugin":
    case "plugins": {
      if (!(await ensureDeps())) process.exit(1);
      const pluginEnv = { ...process.env };
      const configuredAgents = loadConfig().env?.BIVY_CUSTOM_AGENTS;
      if (configuredAgents && pluginEnv.BIVY_CUSTOM_AGENTS === undefined) pluginEnv.BIVY_CUSTOM_AGENTS = String(configuredAgents);
      process.exit(await run(nodeBin, [...nodeScriptArgs(pluginEntry), ...args], { cwd: process.cwd(), env: pluginEnv }));
      break;
    }
    case "stop":
      if (args.includes("-h") || args.includes("--help")) { console.log("Usage: bivy stop\n\nStop the background service."); break; }
      stopService();
      break;
    case "restart":
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy restart [--force|--no-wait]\n\nRestart the background service. Waits for active sessions to finish a turn first; --force/--no-wait skips the wait.");
        break;
      }
      {
      const restartConfig = loadConfig();
      await waitForIdleSessions(restartConfig, { skip: args.includes("--force") || args.includes("--no-wait") });
      if (await restartServiceReconciled(restartConfig)) {
        console.log(c.green("Service restarted."));
      } else if (fs.existsSync(servicePaths().file)) {
        console.error(c.red("Failed to restart the background service."));
        printNodeStartupDiagnostics();
        process.exitCode = 1;
      } else {
        // Remote-only: the node must run as a service to be reachable. Point at
        // setup (which installs one), not a foreground local 'bivy start'. Exit
        // non-zero so callers like install.sh can tell nothing was restarted.
        console.log(c.yellow("No background service to restart. Run 'bivy setup' to install one so the node stays reachable."));
        process.exitCode = 1;
      }
      }
      break;
    case "status":
      await cmdStatus(args);
      break;
    case "doctor":
      await cmdDoctor(args);
      break;
    case "diagnostics":
      await cmdDiagnostics(args);
      break;
    case "logs":
      await cmdLogs(args);
      break;
    case "login":
      await cmdLogin(args);
      break;
    case "update":
      await cmdUpdate(args);
      break;
    case "update:log":
      cmdUpdateLog(args);
      break;
    case "agents:install":
    case "runtimes:install":
      if (args.includes("-h") || args.includes("--help")) {
        console.log(`Usage: bivy agents:install\n\nInstall bundled agent runtimes (${BUNDLED_AGENTS.map((a) => a.label).join(", ")}).`);
        break;
      }
      if (!(await ensureDeps())) process.exit(1);
      await ensureBundledAgents();
      break;
    case "open": {
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy open\n\nOpen the remote web/PWA app in your browser (requires 'bivy relay:setup' first).");
        break;
      }
      const remote = await openRemoteApp();
      if (!remote) {
        console.log("No remote access configured yet.");
        console.log(`Run ${c.cyan("bivy relay:setup")} to enable the web/PWA app, then ${c.cyan("bivy open")}.`);
      } else if (!canOpenBrowser()) {
        console.log(`Open the Bivy app here: ${c.cyan(remote.remoteBase)}`);
      }
      break;
    }
    case "service":
      await cmdService(args);
      break;
    case "uninstall":
      await cmdUninstall(args);
      break;
    case "link":
      await cmdLinkPhone(args);
      break;
    case "relay:setup":
      await cmdRelaySetup(args);
      break;
    case "github:connect":
    case "connect-repo":
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy github:connect [owner/repo]\n\nOpen Settings → GitHub App in the remote app. Self-hosted deployments with BIVY_GITHUB_OAUTH_CLIENT_ID configured use GitHub's device flow instead.");
        break;
      }
      if (!String(process.env.BIVY_GITHUB_OAUTH_CLIENT_ID || loadConfig().env?.BIVY_GITHUB_OAUTH_CLIENT_ID || "").trim()) {
        const remote = await openRemoteApp({ remotePath: "/settings/github" });
        if (!remote) {
          console.log("Remote access is not configured yet.");
          console.log(`Run ${c.cyan("bivy relay:setup")}, then connect GitHub in the app under Settings → GitHub App.`);
        } else if (!canOpenBrowser()) {
          console.log(`Open GitHub setup in the Bivy app: ${c.cyan(remote.openUrl)}`);
        }
        break;
      }
      if (!(await ensureDeps())) process.exit(1);
      process.exit(await run(nodeBin, [...nodeScriptArgs(githubConnectEntry), ...args], { cwd: repoRoot, env: process.env }));
      break;
    case "github:app-connect":
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy github:app-connect --app-id <id>|--slug <slug> --key <path.pem> [--label <name>] [--node-label <label>] [--rotate-webhook]\n\nConnect an existing GitHub App. The private key stays in this node's local vault.");
        break;
      }
      if (!(await ensureDeps())) process.exit(1);
      process.exit(await run(nodeBin, [...nodeScriptArgs(githubAppConnectEntry), ...args], { cwd: repoRoot, env: process.env }));
      break;
    case "github:app-sync":
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy github:app-sync [on|off]\n\nSync connected GitHub App keys (E2E-encrypted) to this account's other opted-in nodes. With no argument, prints the current status.");
        break;
      }
      if (!(await ensureDeps())) process.exit(1);
      process.exit(await run(nodeBin, [...nodeScriptArgs(githubAppSyncEntry), ...args], { cwd: repoRoot, env: process.env }));
      break;
    case "github:app-create": {
      if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: bivy github:app-create [--org <org>]\n\nOne-click: create + connect a GitHub App. Opens the manifest flow in your browser (or prints instructions on a headless server). The private key never leaves this node.");
        break;
      }
      // One-click: open the node's manifest flow in the browser. The node
      // creates the app on GitHub and keeps the private key locally.
      const nodePort = Number(process.env.PORT || 4317);
      const orgArg = argValue(args, "org");
      const manifestUrl = `http://localhost:${nodePort}/github/app/manifest/new${orgArg ? `?org=${encodeURIComponent(orgArg)}` : ""}`;
      if (canOpenBrowser()) {
        console.log("Opening GitHub to create your Bivy app (the private key stays on this node)…");
        console.log(`  ${manifestUrl}`);
        console.log(c.dim("If the node isn't running, start it first: bivy start"));
        openBrowser(manifestUrl);
      } else {
        // Headless server: no local browser to open. The manifest flow still
        // works, but the browser step has to happen elsewhere. The code exchange
        // always runs on this node, so the private key never leaves it.
        console.log("This looks like a headless server (no browser to open).\n");
        console.log("Easiest — set it up from the web app (works remotely):");
        console.log(c.dim("  Open Bivy in any browser (locally or via your hosted control plane),"));
        console.log(c.dim("  go to Settings → GitHub issues → GitHub App, and click 'Create GitHub"));
        console.log(c.dim("  App'. The code is relayed back here for exchange; the key stays local.\n"));
        console.log("Or — drive this CLI flow from a machine with a browser over an SSH tunnel:");
        console.log(`  ssh -L ${nodePort}:localhost:${nodePort} <this-server>`);
        console.log(c.dim("  then open in that browser:"));
        console.log(`  ${manifestUrl}\n`);
        console.log("Or — create the app yourself, then connect it (no browser at all):");
        console.log(c.dim("  Create a GitHub App (Issues/Contents/Pull requests: RW; events: Issues,"));
        console.log(c.dim("  Issue comment), download its .pem, then run:"));
        console.log("  bivy github:app-connect --app-id <id> --key <path.pem>");
      }
      break;
    }
    case "secrets":
    case "secret": {
      if (!(await ensureDeps())) process.exit(1);
      // secrets-cli.ts only recognizes "--help"/"help" as the FIRST argument, so
      // a subcommand-position --help (e.g. 'bivy secrets list --help') would
      // otherwise be ignored and the live action would run anyway (#113).
      const forwardArgs = (args.includes("-h") || args.includes("--help")) ? ["--help"] : args;
      process.exit(await run(nodeBin, [...nodeScriptArgs(secretsEntry), ...forwardArgs], { cwd: repoRoot, env: process.env }));
      break;
    }
    case "voice":
    case "stt": {
      if (!(await ensureDeps())) process.exit(1);
      const forwardArgs = (args.includes("-h") || args.includes("--help")) ? ["--help"] : args;
      process.exit(await run(nodeBin, [...nodeScriptArgs(sttEntry), ...forwardArgs], { cwd: repoRoot, env: process.env }));
      break;
    }
    case "mcp-proxy":
      // Universal Agent Harness MCP proxy. Launched by an agent in front of its
      // MCP servers; its stdin/stdout ARE the JSON-RPC stream, so emit nothing
      // else here (no deps banner) and inherit stdio verbatim. Run in the
      // agent's cwd so relative server commands resolve.
      await run(nodeBin, [...nodeScriptArgs(mcpProxyEntry), ...args], { cwd: process.cwd(), env: process.env });
      break;
    case "mcp-serve":
      // Bivy-owned MCP server (exposes attach_to_chat and future chat tools).
      // Injected into a non-SDK agent's MCP config so the agent discovers the
      // tool; like mcp-proxy its stdin/stdout ARE the JSON-RPC stream, so emit
      // nothing else here and inherit stdio verbatim.
      await run(nodeBin, [...nodeScriptArgs(mcpServeEntry), ...args], { cwd: process.cwd(), env: process.env });
      break;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(readSelfVersion());
      break;
    default:
      console.error(c.red(`Unknown command: ${command}`));
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  // Show a clean message to users; the full stack is only useful with BIVY_DEBUG.
  console.error(c.red(error?.message || String(error)));
  if (process.env.BIVY_DEBUG && error?.stack) console.error(c.dim(error.stack));
  process.exit(1);
});
