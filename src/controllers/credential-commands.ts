// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The credential CRUD + presets command cluster, extracted from server.ts's
// RELAY_COMMANDS (server.ts decomposition; same shape as controllers/
// session-control.ts and fork-commands.ts). The credential vault operations
// already live in credentials/api.ts + runtime/credentials.ts and take the node's
// credsDir explicitly, so this controller imports them directly and only injects
// the handful of daemon bits (credsDir, event emit, and the post-auth refresh /
// provider-list helpers) as composition deps.

import type { CommandEntries } from "../protocol/command-registry.js";
import { testProviderCredential } from "../runtime/credentials.js";
import {
  exportAccountApiKeys,
  exportAccountOAuthCredentials,
  importAccountOAuthCredentials,
  exportRecordTombstones,
  listCredentialRecords,
  removeProviderCredential,
  setProviderApiKeyLabeled,
  setProviderReferenceLabeled,
  setCredentialSync,
  setCredentialUnattended,
  getCredentialPresets,
  setActiveCredentialPreset,
  setCredentialPresetMapping,
} from "../credentials/api.js";

export interface CredentialCommandMessage {
  kind: string;
  requestId?: unknown;
  [key: string]: unknown;
}

export interface CredentialCommandDeps {
  /** The node's credential store directory. */
  credsDir: string;
  /** Emit to the requesting device (server wraps `relay?.sendEvent`). */
  sendEvent(event: unknown): void;
  /** Emit to every connected device (server's `broadcast`). */
  broadcast(event: unknown): void;
  /** Push model-auth to the account vault after a credential change. */
  pushModelAuthToControlPlane(): Promise<void>;
  /** Re-resolve the active session's credentials after an auth change. */
  refreshSessionAfterAuth(): Promise<void>;
  /** The unified provider list broadcast after a credential add/remove. */
  listProvidersUnified(): Promise<unknown>;
}

export function createCredentialCommands(deps: CredentialCommandDeps): CommandEntries<CredentialCommandMessage> {
  const { credsDir } = deps;
  return {
    async "credentials.list"() {
      deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
    },
    async "credentials.account.export"(_msg, ctx) {
      // This reply travels inside the already-paired E2E node channel. OAuth
      // recovery records are encrypted again in the browser's device vault.
      ctx.reply({
        type: "credentials.account.export", requestId: _msg.requestId,
        entries: await exportAccountApiKeys(credsDir),
        ...(_msg.includeOAuth === true ? { oauthEntries: await exportAccountOAuthCredentials(credsDir) } : {}),
        records: await listCredentialRecords(credsDir), deletedAt: await exportRecordTombstones(credsDir),
      });
    },
    async "credentials.account.import"(msg, ctx) {
      try {
        await importAccountOAuthCredentials(credsDir, Array.isArray(msg.oauthEntries) ? msg.oauthEntries : []);
        await deps.pushModelAuthToControlPlane();
        await deps.refreshSessionAfterAuth();
        ctx.reply({ type: "credentials.account.import.ok", requestId: msg.requestId });
      } catch (error) {
        ctx.reply({ type: "credentials.account.import.error", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "credential.set"(msg, ctx) {
      try {
        const provider = String(msg.provider ?? "").trim().toLowerCase();
        const label = String(msg.label ?? "");
        const ref = typeof msg.ref === "string" ? msg.ref.trim() : "";
        const requestedSync = msg.sync === "account" || msg.sync === "node" ? msg.sync : undefined;
        // Persist the secret and its requested tier atomically. Creating a
        // machine-only credential must never leave an account-tier crash window.
        if (ref) await setProviderReferenceLabeled(credsDir, provider, label, ref, requestedSync);
        else await setProviderApiKeyLabeled(credsDir, provider, label, String(msg.key ?? ""), requestedSync);
        await deps.pushModelAuthToControlPlane();
        await deps.refreshSessionAfterAuth();
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
        deps.broadcast({ type: "providers.list", providers: await deps.listProvidersUnified() });
        ctx.reply({ type: "credential.set.ok", requestId: msg.requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.sendEvent({ type: "session.error", error: message });
        ctx.reply({ type: "credential.set.error", requestId: msg.requestId, error: message });
      }
    },
    async "credential.remove"(msg, ctx) {
      try {
        await removeProviderCredential(credsDir, String(msg.provider ?? ""), String(msg.label ?? ""));
        await deps.pushModelAuthToControlPlane();
        await deps.refreshSessionAfterAuth();
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
        deps.broadcast({ type: "providers.list", providers: await deps.listProvidersUnified() });
        ctx.reply({ type: "credential.remove.ok", requestId: msg.requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.sendEvent({ type: "session.error", error: message });
        ctx.reply({ type: "credential.remove.error", requestId: msg.requestId, error: message });
      }
    },
    async "credential.sync.set"(msg, ctx) {
      try {
        const sync = msg.sync === "node" ? "node" : "account";
        await setCredentialSync(credsDir, String(msg.provider ?? ""), String(msg.label ?? ""), sync);
        await deps.pushModelAuthToControlPlane();
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
        ctx.reply({ type: "credential.sync.set.ok", requestId: msg.requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.sendEvent({ type: "session.error", error: message });
        ctx.reply({ type: "credential.sync.set.error", requestId: msg.requestId, error: message });
      }
    },
    async "credential.unattended.set"(msg, ctx) {
      const provider = String(msg.provider ?? "");
      const label = String(msg.label ?? "");
      const previous = (await listCredentialRecords(credsDir)).find((record) => record.provider === provider.trim().toLowerCase() && record.label === label)?.unattended === true;
      try {
        await setCredentialUnattended(credsDir, provider, label, msg.unattended === true);
        await deps.pushModelAuthToControlPlane();
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
        ctx.reply({ type: "credential.unattended.set.ok", requestId: msg.requestId });
      } catch (error) {
        // The UI must never claim an encrypted Cloud copy exists when custody
        // publication failed. Restore the prior local grant before rejecting.
        await setCredentialUnattended(credsDir, provider, label, previous).catch(() => {});
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
        const message = error instanceof Error ? error.message : String(error);
        ctx.reply({ type: "credential.unattended.set.error", requestId: msg.requestId, error: message });
      }
    },
    // "Test connection": a bounded, non-secret liveness probe for one credential
    // record (see credentials/api.ts testCredential). The reply carries only
    // ok/at/reason — the credential's own token never leaves this handler.
    async "credential.test"(msg, ctx) {
      const provider = String(msg.provider ?? "").trim().toLowerCase();
      const label = String(msg.label ?? "");
      try {
        const result = await testProviderCredential(credsDir, provider, label);
        ctx.reply({ type: "credential.test.result", requestId: msg.requestId, provider, label, ...result });
        deps.sendEvent({ type: "credentials.records", records: await listCredentialRecords(credsDir) });
      } catch (error) {
        ctx.reply({ type: "credential.test.result", requestId: msg.requestId, provider, label, ok: false, at: Date.now(), reason: "network_error" });
        deps.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "credentials.presets.get"() {
      deps.sendEvent({ type: "credentials.presets", presets: getCredentialPresets(credsDir) });
    },
    async "credentials.presets.setActive"(msg) {
      try {
        setActiveCredentialPreset(credsDir, String(msg.active ?? ""));
        await deps.refreshSessionAfterAuth();
        deps.sendEvent({ type: "credentials.presets", presets: getCredentialPresets(credsDir) });
      } catch (error) {
        deps.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "credentials.presets.setMapping"(msg, ctx) {
      try {
        setCredentialPresetMapping(credsDir, String(msg.preset ?? ""), String(msg.provider ?? ""), String(msg.label ?? ""));
        await deps.refreshSessionAfterAuth();
        deps.sendEvent({ type: "credentials.presets", presets: getCredentialPresets(credsDir) });
        ctx.reply({ type: "credentials.presets.setMapping.ok", requestId: msg.requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.reply({ type: "credentials.presets.setMapping.error", requestId: msg.requestId, error: message });
      }
    },
  };
}
