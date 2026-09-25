// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Who may write an account's hosted model-auth custody. Personal Machines are
// the authorities; a managed setup guest may publish only the first filtered
// snapshot and never replace custody once an agent could have run on it. The
// legacy key-only endpoint exists so pre-vault nodes fail safely during a
// rolling upgrade: it must never overwrite an active filtered snapshot.

export interface HostedVaultWriteContext {
  provisioningEnabled: boolean;
  /** The writing node is a Bivy-managed guest machine. */
  managedGuest: boolean;
  /** A filtered hosted snapshot already exists for the account. */
  vaultActive: boolean;
}

export type HostedVaultRejection = { status: 403 | 409; error: string };

/** Rejection for a filtered-snapshot write, or null when it may proceed. */
export function hostedVaultWriteRejection(ctx: HostedVaultWriteContext): HostedVaultRejection | null {
  if (!ctx.provisioningEnabled) return { status: 403, error: "hosted provisioning not enabled for this account" };
  if (ctx.managedGuest && ctx.vaultActive) return { status: 403, error: "managed guests cannot replace hosted credentials" };
  return null;
}

/** Rejection for a legacy key-only escrow write, or null when it may proceed. */
export function legacyEscrowWriteRejection(ctx: Omit<HostedVaultWriteContext, "managedGuest">): HostedVaultRejection | null {
  if (!ctx.provisioningEnabled) return { status: 403, error: "hosted provisioning not enabled for this account" };
  if (ctx.vaultActive) return { status: 409, error: "filtered hosted credential vault already active" };
  return null;
}
