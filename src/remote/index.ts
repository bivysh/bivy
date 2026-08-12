// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// `@bivy/remote` (in-repo facade) — the removable module that makes a local node
// remotely reachable: relay transport today, control-plane sync + remote session
// location as later slices fold in. Platform modularization Phase 3.
//
// The kernel imports remote ONLY through this facade, never a concrete file, and
// remote imports nothing from server.ts (the composition root) — enforced by
// scripts/check-module-boundaries.mjs. This is the seam that lets the node run
// with remote absent (already true: the relay is opt-in) and, later, lets remote
// promote to a standalone `@bivy/remote` npm package.
//
// Slice 1 relocates the relay transport (RelayConnector) here behind the facade.
// Next slices invert construction + the model-auth sync wire behind ports, then
// the remaining remote-only code moves in.
export { RelayConnector, loadRelayConfig } from "./relay-client.js";
export type { ClientMessage, RelayConfig } from "./relay-client.js";
export { soloCredentials, buildDialUrl } from "./solo.js";
export type { SoloCredentials } from "./solo.js";
