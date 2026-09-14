// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AccountAuthRepository } from "./store.js";

/** Only called by the server-shell command, never registered as an HTTP route. */
export async function operatorLoginLink(
  store: Pick<AccountAuthRepository, "createLoginToken">,
  email: string,
  publicUrl: string,
): Promise<string> {
  const identity = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) throw new Error("Set SELF_HOST_OWNER_EMAIL to a valid account identity.");
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_CONTROL_PLANE_URL must be an HTTPS origin.");
  }
  const token = await store.createLoginToken(identity);
  url.pathname = "/auth/magic-link/consume";
  url.searchParams.set("token", token);
  return url.toString();
}
