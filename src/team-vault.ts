// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { seal, open } from "./e2e.js";

/**
 * This machine's side of the team vault (services/control-plane/src/team-vault.ts):
 * team instructions written by a team admin, end-to-end encrypted, for every
 * agent session on every team member's machines.
 *
 * The control plane holds ciphertext and, per machine, the vault key sealed
 * between two machines ("team-vault" wrap purpose). A sync tick:
 *  1. reads the vault, opening it with the cached key or the one sealed for us;
 *  2. asks for the key when it has none (another member's machine answers);
 *  3. seals the key for team machines that are asking;
 *  4. on an admin's machine, re-encrypts under a fresh key after a member left.
 *
 * Opened instructions are kept in `<appDir>/team-instructions.json` so a
 * session starting offline still gets them; the key in `team-vault.json`
 * (0600). Both are removed when this machine's account leaves the team.
 */

export const MAX_TEAM_INSTRUCTIONS_BYTES = 16 * 1024;
const ENVELOPE_VERSION = 1;

/** Names agents use for keys: the same rule as personal keys (src/secrets.ts). */
export const TEAM_KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_TEAM_KEY_BYTES = 8 * 1024;
export const MAX_TEAM_KEYS = 100;

/** What the vault holds once opened. Key values never leave this module's
 * callers except into the machine's encrypted secret vault. */
export interface TeamBody {
  text: string;
  updatedAt: number;
  keys: Record<string, { value: string; updatedAt: number }>;
}

/** A change an admin's machine makes to the vault. */
export interface TeamVaultPatch {
  text?: string;
  setKey?: { name: string; value: string };
  removeKey?: string;
}

/** Where a machine keeps opened team keys: its encrypted secret vault. */
export interface TeamKeyStore {
  names(): string[];
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
}

export interface TeamInstructions {
  teamId: string;
  teamName: string;
  text: string;
  /** Epoch ms of the admin's last edit; 0 before anyone wrote. */
  updatedAt: number;
  /** The vault generation these were read from (a writer names it to save). */
  generation: number;
  /** Team keys by name; values are in the secret vault, not here. */
  keys: Array<{ name: string; updatedAt: number }>;
}

export type TeamVaultState =
  /** Not in a team, or never synced. */
  | "none"
  /** In a team; instructions (possibly empty) are current. */
  | "ready"
  /** The team has instructions this machine can't open yet; it asked for the key. */
  | "waiting-for-key";

export interface TeamVaultStatus {
  state: TeamVaultState;
  team?: { id: string; name: string; role: "admin" | "member" };
}

interface Snapshot {
  team: { id: string; name: string } | null;
  role?: "admin" | "member";
  vault?: { ciphertext: string; generation: number; keyGeneration: number; needsRotation: boolean };
  wrappedKey?: { wrappedKey: string; wrappedByPublicKey: string; keyGeneration: number };
  requests?: Array<{ nodeId: string; publicKey: string }>;
}

interface LocalKey { teamId: string; keyB64: string; keyGeneration: number }

export interface TeamVaultDeps {
  appDir: string;
  nodeId: string;
  /** Authenticated control-plane request; null when this machine isn't enrolled. */
  request(pathname: string, init?: RequestInit): Promise<Response | null>;
  publicKey(): string;
  wrap(publicKeyB64: string, keyB64: string): string;
  unwrap(publicKeyB64: string, wrapped: string): string;
  keyStore?: TeamKeyStore;
}

const instructionsPath = (appDir: string) => path.join(appDir, "team-instructions.json");
const keyPath = (appDir: string) => path.join(appDir, "team-vault.json");

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

/** The team instructions this machine last opened, if its account is in a team. */
export function readTeamInstructions(appDir: string): TeamInstructions | undefined {
  const value = readJson<Partial<TeamInstructions>>(instructionsPath(appDir));
  if (!value || typeof value.teamId !== "string" || typeof value.text !== "string") return undefined;
  return {
    teamId: value.teamId, teamName: String(value.teamName ?? ""), text: value.text,
    updatedAt: Number(value.updatedAt) || 0, generation: Number(value.generation) || 0,
    keys: Array.isArray(value.keys) ? value.keys.filter((k) => typeof k?.name === "string") : [],
  };
}

const EMPTY_BODY: TeamBody = { text: "", updatedAt: 0, keys: {} };

export function sealTeamEnvelope(keyB64: string, body: TeamBody): string {
  return seal(Buffer.from(keyB64, "base64"), JSON.stringify({ v: ENVELOPE_VERSION, ...body }));
}

export function openTeamEnvelope(keyB64: string, ciphertext: string): TeamBody {
  const parsed = JSON.parse(open(Buffer.from(keyB64, "base64"), ciphertext)) as { text?: unknown; updatedAt?: unknown; keys?: unknown };
  if (typeof parsed?.text !== "string") throw new Error("Malformed team vault envelope");
  const keys: TeamBody["keys"] = {};
  if (parsed.keys && typeof parsed.keys === "object") {
    for (const [name, entry] of Object.entries(parsed.keys as Record<string, { value?: unknown; updatedAt?: unknown }>)) {
      if (TEAM_KEY_NAME.test(name) && typeof entry?.value === "string") keys[name] = { value: entry.value, updatedAt: Number(entry.updatedAt) || 0 };
    }
  }
  return { text: parsed.text, updatedAt: Number(parsed.updatedAt) || 0, keys };
}

/** Apply an admin's change. Throws on an invalid key or one over the limits. */
export function applyTeamPatch(body: TeamBody, patch: TeamVaultPatch, now = Date.now()): TeamBody {
  const next: TeamBody = { text: body.text, updatedAt: body.updatedAt, keys: { ...body.keys } };
  if (typeof patch.text === "string") {
    if (Buffer.byteLength(patch.text, "utf8") > MAX_TEAM_INSTRUCTIONS_BYTES) throw new Error("Team instructions are too long");
    next.text = patch.text;
    next.updatedAt = now;
  }
  if (patch.setKey) {
    const { name, value } = patch.setKey;
    if (!TEAM_KEY_NAME.test(name)) throw new Error("A key name is a letter followed by letters, digits or underscores (up to 64), like STRIPE_API_KEY.");
    if (!value || Buffer.byteLength(value, "utf8") > MAX_TEAM_KEY_BYTES) throw new Error("A key's value is 1 byte to 8 KB.");
    if (!(name in next.keys) && Object.keys(next.keys).length >= MAX_TEAM_KEYS) throw new Error(`A team can have at most ${MAX_TEAM_KEYS} keys.`);
    next.keys[name] = { value, updatedAt: now };
  }
  if (typeof patch.removeKey === "string") delete next.keys[patch.removeKey];
  return next;
}

export class TeamVaultSync {
  private status: TeamVaultStatus = { state: "none" };
  /** The vault as last opened (undefined until this machine could open it). */
  private body: TeamBody | undefined;
  private running: Promise<Snapshot | undefined> | null = null;

  constructor(private readonly deps: TeamVaultDeps) {}

  current(): TeamVaultStatus & { instructions?: TeamInstructions } {
    const instructions = readTeamInstructions(this.deps.appDir);
    return { ...this.status, ...(instructions && instructions.teamId === this.status.team?.id ? { instructions } : {}) };
  }

  /** One sync tick. Concurrent calls share the tick in flight. */
  sync(): Promise<Snapshot | undefined> {
    this.running ??= this.tick().finally(() => { this.running = null; });
    return this.running;
  }

  /** Change the team's instructions or keys from this (admin's) machine.
   * `baseGeneration` is the generation the editor loaded; the save fails if
   * the vault moved on. */
  async write(patch: TeamVaultPatch, baseGeneration: number): Promise<TeamInstructions> {
    const snapshot = await this.sync();
    if (!snapshot?.team) throw new Error("This machine's account isn't in a team");
    if (snapshot.role !== "admin") throw new Error("Only a team admin can change the team's instructions or keys");
    const generation = snapshot.vault?.generation ?? 0;
    if (generation !== baseGeneration) throw new Error("The team's instructions or keys were changed elsewhere. Reload before saving.");
    // Never overwrite what this machine can't read: the keys would be lost.
    const current = snapshot.vault ? this.body : EMPTY_BODY;
    if (!current) throw new Error("This machine can't open the team's vault yet. Try again once another member's machine is online.");
    const next = applyTeamPatch(current, patch);
    const key = this.usableKey(snapshot);
    const freshKey = !key || !snapshot.vault || snapshot.vault.needsRotation;
    const saved = await this.push(snapshot, next, freshKey ? undefined : key);
    if (!saved) throw new Error("Could not save. Try again.");
    return saved;
  }

  private forget(): void {
    fs.rmSync(instructionsPath(this.deps.appDir), { force: true });
    fs.rmSync(keyPath(this.deps.appDir), { force: true });
    for (const name of this.deps.keyStore?.names() ?? []) this.deps.keyStore!.remove(name);
    this.body = undefined;
  }

  private localKey(teamId: string): LocalKey | undefined {
    const key = readJson<LocalKey>(keyPath(this.deps.appDir));
    return key?.teamId === teamId && typeof key.keyB64 === "string" ? key : undefined;
  }

  /** The current key: cached, or unsealed from the copy sealed for this machine. */
  private usableKey(snapshot: Snapshot): LocalKey | undefined {
    const team = snapshot.team!;
    const keyGeneration = snapshot.vault?.keyGeneration;
    const cached = this.localKey(team.id);
    if (cached && (keyGeneration === undefined || cached.keyGeneration === keyGeneration)) return cached;
    const sealed = snapshot.wrappedKey;
    if (!sealed || (keyGeneration !== undefined && sealed.keyGeneration !== keyGeneration)) return undefined;
    try {
      const key = { teamId: team.id, keyB64: this.deps.unwrap(sealed.wrappedByPublicKey, sealed.wrappedKey), keyGeneration: sealed.keyGeneration };
      writePrivate(keyPath(this.deps.appDir), key);
      return key;
    } catch {
      return undefined;
    }
  }

  private keep(team: { id: string; name: string }, body: TeamBody, generation: number): TeamInstructions {
    this.body = body;
    const keys = Object.entries(body.keys).map(([name, { updatedAt }]) => ({ name, updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
    const instructions: TeamInstructions = { teamId: team.id, teamName: team.name, text: body.text, updatedAt: body.updatedAt, generation, keys };
    const current = readTeamInstructions(this.deps.appDir);
    if (JSON.stringify(current) !== JSON.stringify(instructions)) writePrivate(instructionsPath(this.deps.appDir), instructions);
    const store = this.deps.keyStore;
    if (store) {
      for (const [name, { value }] of Object.entries(body.keys)) if (store.get(name) !== value) store.set(name, value);
      for (const name of store.names()) if (!(name in body.keys)) store.remove(name);
    }
    return instructions;
  }

  /** Encrypt and store; a missing key means "mint a fresh one". */
  private async push(snapshot: Snapshot, body: TeamBody, key: LocalKey | undefined): Promise<TeamInstructions | undefined> {
    const team = snapshot.team!;
    const fresh: LocalKey = key ?? { teamId: team.id, keyB64: randomBytes(32).toString("base64"), keyGeneration: (snapshot.vault?.keyGeneration ?? 0) + 1 };
    const res = await this.deps.request("/node/team-vault", {
      method: "PUT",
      body: JSON.stringify({ ciphertext: sealTeamEnvelope(fresh.keyB64, body), expectedGeneration: snapshot.vault?.generation ?? 0, freshKey: !key }),
    });
    if (!res?.ok) return undefined;
    const { vault } = (await res.json()) as { vault: { generation: number; keyGeneration: number } };
    const stored = { ...fresh, keyGeneration: vault.keyGeneration };
    writePrivate(keyPath(this.deps.appDir), stored);
    // Seal for ourselves too, so a machine that loses team-vault.json recovers on its own.
    await this.sealFor(this.deps.nodeId, this.deps.publicKey(), stored);
    return this.keep(team, body, vault.generation);
  }

  private async sealFor(nodeId: string, publicKey: string, key: LocalKey): Promise<void> {
    await this.deps.request("/node/team-vault/key", {
      method: "PUT",
      body: JSON.stringify({ targetNodeId: nodeId, wrappedKey: this.deps.wrap(publicKey, key.keyB64), wrappedByPublicKey: this.deps.publicKey(), keyGeneration: key.keyGeneration }),
    }).catch(() => null);
  }

  private async tick(): Promise<Snapshot | undefined> {
    const res = await this.deps.request("/node/team-vault").catch(() => null);
    if (!res?.ok) return undefined;
    const snapshot = (await res.json()) as Snapshot;
    const team = snapshot.team;
    if (!team) {
      this.forget();
      this.status = { state: "none" };
      return snapshot;
    }
    const role = snapshot.role === "admin" ? "admin" : "member";
    const local = readTeamInstructions(this.deps.appDir);
    if (local && local.teamId !== team.id) this.forget();
    const vault = snapshot.vault;
    if (!vault) {
      this.keep(team, EMPTY_BODY, 0);
      this.status = { state: "ready", team: { ...team, role } };
      return snapshot;
    }
    let key = this.usableKey(snapshot);
    let body: TeamBody | undefined;
    if (key) {
      try { body = openTeamEnvelope(key.keyB64, vault.ciphertext); } catch {
        fs.rmSync(keyPath(this.deps.appDir), { force: true });
        key = undefined;
      }
    }
    if (!key || !body) {
      await this.deps.request("/node/team-vault/key-request", { method: "POST", body: JSON.stringify({ publicKey: this.deps.publicKey() }) }).catch(() => null);
      this.status = { state: "waiting-for-key", team: { ...team, role } };
      return snapshot;
    }
    this.keep(team, body, vault.generation);
    this.status = { state: "ready", team: { ...team, role } };
    for (const request of snapshot.requests ?? []) await this.sealFor(request.nodeId, request.publicKey, key);
    // Someone left: an admin's machine moves the team onto a key they never had.
    if (vault.needsRotation && role === "admin") await this.push(snapshot, body, undefined).catch(() => undefined);
    return snapshot;
  }
}
