// SPDX-License-Identifier: AGPL-3.0-only
import React from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../packages/web/src/components/Composer.js";
import { controller, useAppState } from "../../packages/web/src/store/useStore.js";

// Real Composer, picker, selection controller and store. Discovery is the
// supplied node response below, not the controller's disconnected fallback.
controller.listModels = () => {};
controller.listProviders = () => {};
const runtime = { id: "fixture-acp", name: "Fixture ACP", capabilities: { modelSelection: false } };
controller.store.apply({ type: "runtimes.list", runtimes: [runtime], current: runtime } as any);
const query = new URLSearchParams(location.search);
const model = { id: "model-a", provider: "fixture", label: "Model A" };
controller.store.apply({ type: "models.list", runtimeId: query.get("scope") || runtime.id,
  models: query.has("empty") ? [] : [model, { ...model, id: "model-b", label: "Model B" }].map(m => ({ ...m, configured: !query.has("unconfigured") })), current: model } as any);
// Static catalog refresh must not disable an already-discovered model list.
controller.store.apply({ type: "runtimes.list", runtimes: [runtime], current: runtime } as any);
if (query.has("pending")) controller.store.persistPendingSession("pending-fixture", "Starting agent");
function App() {
  const state = useAppState();
  return <Composer state={state} disabled={false} working={false} onSend={() => { throw new Error("No inference in this fixture"); }} onAbort={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<App />);
