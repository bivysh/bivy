// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Account-free ("solo") relay admission — client side.
//
// A solo node/client reaches a self-hosted relay (started with
// RELAY_ALLOW_ROOM_TOKENS=1) by presenting an unguessable `room` id plus a
// bearer `roomToken`, both carried out-of-band in the pairing QR, instead of a
// control-plane-introspected ticket. This module is a PURE leaf: URL/credential
// shaping only, no I/O and no heavy imports, so it unit-tests in isolation and
// keeps src/remote a boundary-clean module (see check-module-boundaries.mjs).

export interface SoloCredentials {
  /** Unguessable room id (shared out-of-band via the pairing QR). */
  room: string;
  /** High-entropy bearer capability for that room (the pairing secret). */
  roomToken: string;
}

/** A config is solo iff BOTH the room id and its token are present. Partial
 *  values are treated as not-solo so a half-written config never silently
 *  drops the (authenticated) hosted path. */
export function soloCredentials(config: {
  room?: string;
  roomToken?: string;
}): SoloCredentials | null {
  const room = config.room?.trim();
  const roomToken = config.roomToken?.trim();
  if (room && roomToken) return { room, roomToken };
  return null;
}

/**
 * Build the relay dial URL for the given role. Solo presents `room`+`roomToken`;
 * the hosted path presents a single-use `ticket`. Kept in one place so both
 * paths stay symmetric with the relay's `handleConnection` param names.
 */
export function buildDialUrl(
  relayBase: string,
  role: "node" | "client",
  auth: { ticket: string } | SoloCredentials,
): string {
  const base = relayBase.replace(/\/$/, "");
  if ("ticket" in auth) {
    return `${base}/${role}?ticket=${encodeURIComponent(auth.ticket)}`;
  }
  return (
    `${base}/${role}?room=${encodeURIComponent(auth.room)}` +
    `&roomToken=${encodeURIComponent(auth.roomToken)}`
  );
}
