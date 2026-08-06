// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Speech-to-text (voice input) — shared logic for the node server and the CLI.
//
// A voice recording captured in the web app (or any client) is forwarded to the
// node, which holds the provider API key and makes the transcription call on the
// user's behalf. Two providers are supported; the user picks a preferred one and
// stores a key per provider. Keys live in the encrypted SecretVault (never in
// settings.json); the preferred provider is a plain setting.
//
// Both providers expose the same OpenAI-compatible /audio/transcriptions
// multipart endpoint that returns `{ text }`, which keeps the call site uniform.

import fs from "node:fs";
import path from "node:path";
import { SecretVault } from "./secrets.js";

export type SttProvider = "groq" | "openai";

export interface SttProviderSpec {
  id: SttProvider;
  label: string;
  /** OpenAI-compatible transcription endpoint. */
  url: string;
  /** Default transcription model. */
  model: string;
  /** Environment-variable fallback when no vault key is stored. */
  keyEnv: string;
}

export const STT_PROVIDERS: Record<SttProvider, SttProviderSpec> = {
  groq: {
    id: "groq",
    label: "Groq (Whisper)",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
    keyEnv: "GROQ_API_KEY",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: "gpt-4o-mini-transcribe",
    keyEnv: "OPENAI_API_KEY",
  },
};

export const DEFAULT_STT_PROVIDER: SttProvider = "groq";

/** Max audio payload we forward to a provider (their own caps are ~25 MB). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function isSttProvider(value: unknown): value is SttProvider {
  return value === "groq" || value === "openai";
}

export function sttProviderList(): SttProvider[] {
  return Object.keys(STT_PROVIDERS) as SttProvider[];
}

/** Vault secret id holding a provider's API key. */
export function sttKeyId(provider: SttProvider): string {
  return `stt.${provider}`;
}

function settingsPath(appDir: string): string {
  return path.join(appDir, "settings.json");
}

function readSettings(appDir: string): Record<string, unknown> {
  try {
    const file = settingsPath(appDir);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Read-modify-write so we never clobber unrelated settings (approvalMode, etc.).
function writeSettings(appDir: string, settings: Record<string, unknown>) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(settingsPath(appDir), `${JSON.stringify(settings, null, 2)}\n`);
}

export function getSttProvider(appDir: string): SttProvider {
  const raw = readSettings(appDir).sttProvider;
  return isSttProvider(raw) ? raw : DEFAULT_STT_PROVIDER;
}

export function setSttProvider(appDir: string, provider: SttProvider): SttProvider {
  if (!isSttProvider(provider)) throw new Error(`Unknown speech provider: ${provider}`);
  const settings = readSettings(appDir);
  settings.sttProvider = provider;
  writeSettings(appDir, settings);
  return provider;
}

/** Resolve a provider key: stored vault secret first, then env-var fallback. */
export async function resolveSttKey(appDir: string, provider: SttProvider): Promise<string | undefined> {
  const fromVault = await new SecretVault(appDir).resolve(sttKeyId(provider)).catch(() => undefined);
  if (fromVault) return fromVault;
  const env = process.env[STT_PROVIDERS[provider].keyEnv];
  return env && env.trim() ? env.trim() : undefined;
}

export function setSttKey(appDir: string, provider: SttProvider, key: string): void {
  if (!isSttProvider(provider)) throw new Error(`Unknown speech provider: ${provider}`);
  const value = String(key || "").trim();
  if (!value) throw new Error("API key cannot be empty.");
  new SecretVault(appDir).setLocal(sttKeyId(provider), value, `${STT_PROVIDERS[provider].label} speech-to-text key`);
}

export function removeSttKey(appDir: string, provider: SttProvider): boolean {
  if (!isSttProvider(provider)) throw new Error(`Unknown speech provider: ${provider}`);
  return new SecretVault(appDir).delete(sttKeyId(provider));
}

export interface SttProviderStatus {
  id: SttProvider;
  label: string;
  model: string;
  /** True when a key is available (vault or env). */
  configured: boolean;
}

export interface SttConfig {
  provider: SttProvider;
  providers: SttProviderStatus[];
}

/** The voice-input status the settings UIs render: chosen provider + which keys exist. */
export async function getSttConfig(appDir: string): Promise<SttConfig> {
  const provider = getSttProvider(appDir);
  const providers = await Promise.all(
    sttProviderList().map(async (id): Promise<SttProviderStatus> => ({
      id,
      label: STT_PROVIDERS[id].label,
      model: STT_PROVIDERS[id].model,
      configured: Boolean(await resolveSttKey(appDir, id)),
    })),
  );
  return { provider, providers };
}

export interface TranscribeInput {
  appDir: string;
  audio: Buffer;
  mimeType?: string;
  filename?: string;
  /** Override the preferred provider for this one call. */
  provider?: SttProvider;
  /** Optional ISO-639-1 hint (e.g. "no", "en"). Omit to auto-detect. */
  language?: string;
}

/** Send audio to the chosen provider and return the transcript text. */
export async function transcribeAudio(input: TranscribeInput): Promise<string> {
  const provider = isSttProvider(input.provider) ? input.provider : getSttProvider(input.appDir);
  const spec = STT_PROVIDERS[provider];
  if (!input.audio || input.audio.length === 0) throw new Error("No audio was recorded.");
  if (input.audio.length > MAX_AUDIO_BYTES) throw new Error("Recording is too large to transcribe.");

  const key = await resolveSttKey(input.appDir, provider);
  if (!key) {
    throw new Error(
      `No API key set for ${spec.label}. Add one in Settings → Voice input, or run 'bivy voice key ${provider}'.`,
    );
  }

  const mime = input.mimeType || "audio/webm";
  const filename = input.filename || `audio.${extensionForMime(mime)}`;
  const form = new FormData();
  // Copy into a plain Uint8Array — a Node Buffer's backing store is typed as
  // possibly-SharedArrayBuffer, which isn't a valid BlobPart under DOM lib types.
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: mime }), filename);
  form.append("model", spec.model);
  form.append("response_format", "json");
  if (input.language) form.append("language", input.language);

  let res: Response;
  try {
    res = await fetch(spec.url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  } catch (error) {
    throw new Error(`Could not reach ${spec.label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = (JSON.parse(body) as { error?: { message?: string } })?.error?.message || detail;
    } catch {
      /* keep raw body */
    }
    throw new Error(`${spec.label} transcription failed (${res.status}): ${detail}`);
  }

  let data: { text?: string };
  try {
    data = JSON.parse(body) as { text?: string };
  } catch {
    throw new Error(`${spec.label} returned an unreadable response.`);
  }
  return String(data.text ?? "").trim();
}

function extensionForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}
