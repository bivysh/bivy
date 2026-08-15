// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The local/custom-model registry command cluster (models.custom.*), extracted
// from server.ts's RELAY_COMMANDS (server.ts decomposition; same shape as the
// other controllers/*). The registry itself lives in the model controller; these
// handlers are thin event-wiring over its operations, injected as deps.

import type { CommandEntries } from "../protocol/command-registry.js";

export interface CustomModelCommandMessage {
  kind: string;
  requestId?: unknown;
  [key: string]: unknown;
}

export interface CustomModelCommandDeps {
  /** Emit to the requesting device (server wraps `relay?.sendEvent`). */
  sendEvent(event: unknown): void;
  /** The node's local/custom model providers, summarised for the picker. */
  localModelSummaries(): Promise<unknown>;
  /** The built-in local-model presets (Ollama/LM Studio/…). */
  localModelPresets(): Promise<unknown>;
  /** Probe the machine for locally-served model endpoints. */
  discoverModelsOnMachine(): Promise<Record<string, unknown>>;
  /** Verify one endpoint spec (base URL/api/models) is reachable + valid. */
  verifyModelEndpoint(spec: unknown): Promise<unknown>;
  /** Persist a custom model provider; broadcasts the refreshed list itself. */
  persistLocalModelSave(spec: unknown): Promise<{ id: string }>;
  /** Remove a custom model provider by id. */
  persistLocalModelRemove(id: string): Promise<void>;
}

export function createCustomModelCommands(deps: CustomModelCommandDeps): CommandEntries<CustomModelCommandMessage> {
  return {
    async "models.custom.list"() {
      deps.sendEvent({ type: "models.custom.list", providers: await deps.localModelSummaries() });
    },
    async "models.custom.presets"() {
      deps.sendEvent({ type: "models.custom.presets", presets: await deps.localModelPresets() });
    },
    async "models.custom.discover"(_msg, ctx) {
      try {
        ctx.reply({ type: "models.custom.discover.ok", ...(await deps.discoverModelsOnMachine()) });
      } catch (error) {
        ctx.reply({ type: "models.custom.discover.error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "models.custom.verify"(msg, ctx) {
      try {
        ctx.reply({ type: "models.custom.verify.ok", result: await deps.verifyModelEndpoint(msg) });
      } catch (error) {
        ctx.reply({ type: "models.custom.verify.error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "models.custom.save"(msg, ctx) {
      try {
        // The client sends the same field set as the REST body (baseUrl, api,
        // apiKey, models[], compat, name, providerId). persistLocalModelSave
        // broadcasts the refreshed list to every client, requester included.
        const result = await deps.persistLocalModelSave((msg as { spec?: unknown })?.spec ?? msg);
        // Return the normalized (Machine-scoped) provider id so the PWA can make
        // the imported model the next draft's explicit choice.
        ctx.reply({ type: "models.custom.save.ok", requestId: msg.requestId, provider: result.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.sendEvent({ type: "session.error", error: message });
        ctx.reply({ type: "models.custom.save.error", requestId: msg.requestId, error: message });
      }
    },
    async "models.custom.remove"(msg) {
      try {
        await deps.persistLocalModelRemove(String((msg as { id?: unknown; provider?: unknown }).id ?? (msg as { provider?: unknown }).provider ?? ""));
      } catch (error) {
        deps.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
