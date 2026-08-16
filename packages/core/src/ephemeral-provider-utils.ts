// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Provider-neutral transport and formatting utilities shared by interpreters.

import type { ExecFn, ExecRequest, ExecResult } from "./ephemeral-provider-ports.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ALLOWED_HOSTS = [
  "api.hetzner.cloud", "api.machines.dev", "api.fly.io",
  "ec2.us-east-1.amazonaws.com", "ec2.us-west-2.amazonaws.com", "ec2.eu-west-1.amazonaws.com",
  "ec2.eu-central-1.amazonaws.com", "ec2.ap-southeast-1.amazonaws.com", "ec2.ap-northeast-1.amazonaws.com",
  "ssm.us-east-1.amazonaws.com", "ssm.us-west-2.amazonaws.com", "ssm.eu-west-1.amazonaws.com",
  "ssm.eu-central-1.amazonaws.com", "ssm.ap-southeast-1.amazonaws.com", "ssm.ap-northeast-1.amazonaws.com",
];

export const utf8 = new TextEncoder();

export function assertAllowedUrl(url: string): string {
  let host: string;
  try { host = new URL(url).host; } catch { throw new Error(`Bad provider URL: ${url}`); }
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`Refusing to send a token to non-provider host: ${host}`);
  return url;
}

export async function call(exec: ExecFn, request: ExecRequest): Promise<ExecResult> {
  assertAllowedUrl(request.url);
  return (await exec(request)) || { status: 0, body: null };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${String(token || "").trim()}` };
}

export function shq(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function nowIso(): string {
  try { return new Date().toISOString(); } catch { return ""; }
}

export function extractProviderMessage(body: any): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body.message === "string") return body.message;
  if (body.error && typeof body.error === "object") {
    const error = body.error;
    let message = typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : "";
    const fields = error.details && Array.isArray(error.details.fields) ? error.details.fields : null;
    if (fields?.length) {
      const detail = fields.map((field: any) => `${field.name}: ${Array.isArray(field.messages) ? field.messages.join(", ") : field.messages || ""}`).filter(Boolean).join("; ");
      if (detail) message = message ? `${message} (${detail})` : detail;
    }
    return message;
  }
  if (typeof body.error === "string") return body.error;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((error: any) => (typeof error === "string" ? error : error?.message) || "").filter(Boolean).join("; ");
  }
  return "";
}

export function providerError(res: ExecResult, action: string): string {
  const message = extractProviderMessage(res?.body);
  return `Provider failed to ${action} (HTTP ${res?.status}${message ? `: ${message}` : ""})`;
}

/** Deduplicate concurrent reads and evict failures so later calls can retry. */
export function memoizeByKey<T>(store: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit;
  const pending = fn().catch((error) => { store.delete(key); throw error; });
  store.set(key, pending);
  return pending;
}
