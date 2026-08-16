// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { EPHEMERAL_PROVIDERS, ephemeralAdapter, ephemeralCostHint, type DeviceVaultSyncState, type EphemeralNodeConfig, type ProviderKeyInfo } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Badge } from "./Badge.js";

/**
 * Connect-a-cloud-provider sheet — the onboarding entry point for ephemeral
 * runners. Its ONLY job is getting a provider token saved; connecting a provider
 * auto-creates a default runner and picks it for the draft, so the user returns
 * to the composer and their first message launches the machine. There is no
 * "launch" button and no machine management here — a runner is a node you pick
 * (node switcher) and machines are launched by sending, not by a modal. Region /
 * size / TTL live in Settings → Ephemeral machines.
 */
export function EphemeralSheet({ onClose, firstRun = false }: { onClose: () => void; firstRun?: boolean }) {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys).catch(() => {});
  const recommended = EPHEMERAL_PROVIDERS.find((p) => p.id === "fly") ?? EPHEMERAL_PROVIDERS[0];
  const alternatives = EPHEMERAL_PROVIDERS.filter((p) => p.id !== recommended?.id);
  useEffect(() => { refreshKeys(); }, []);

  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === provider);
  return (
    <Sheet
      title={catalog ? catalog.name : "Connect a cloud provider"}
      onClose={onClose}
      headExtra={provider ? (
        <button className="sheet-back" onClick={() => setProvider(null)} aria-label="Back">‹</button>
      ) : undefined}
    >
      {!provider ? (
        <div className="picker-list">
          <p className="muted settings-intro">
            {firstRun
              ? "Connect your own cloud account to run agents on temporary servers. Pick a provider, paste a token, and you're ready — your first message launches the machine."
              : "Pick a provider and paste a token. Connecting one adds an isolated machine profile you can pick in the machine menu."}
          </p>
          {recommended && (() => {
            const k = keys.find((x) => x.id === recommended.id);
            return (
              <PickerItem
                key={recommended.id}
                title={`${recommended.name} · Recommended`}
                meta={recommended.blurb}
                right={k?.configured ? <Badge tone="ok">Connected</Badge> : <Badge>Stable</Badge>}
                onClick={() => setProvider(recommended.id)}
              />
            );
          })()}
          <button type="button" className="btn ghost block" aria-expanded={showMore} onClick={() => setShowMore((value) => !value)}>
            {showMore ? "Hide other cloud providers" : "Other cloud providers"}
          </button>
          {showMore && alternatives.map((p) => {
            const k = keys.find((x) => x.id === p.id);
            return (
              <PickerItem
                key={p.id}
                title={p.name}
                meta={p.blurb}
                right={k?.configured
                  ? <Badge tone="ok">Connected</Badge>
                  : p.hostedOnly
                    ? <Badge tone="accent">Server-managed</Badge>
                    : <Badge>Available</Badge>}
                onClick={() => setProvider(p.id)}
              />
            );
          })}
        </div>
      ) : (
        <ProviderConnectPanel providerId={provider} onKeysChanged={refreshKeys} onDone={onClose} />
      )}
    </Sheet>
  );
}

function ProviderConnectPanel({ providerId, onKeysChanged, onDone }: { providerId: string; onKeysChanged: () => void; onDone: () => void }) {
  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === providerId)!;
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; action: () => void }>(null);
  const [pendingRunner, setPendingRunner] = useState<EphemeralNodeConfig | null>(null);
  const [syncState, setSyncState] = useState<DeviceVaultSyncState>(() => controller.getDeviceVaultSyncState());

  useEffect(() => {
    controller.getEphemeralToken(providerId).then((t) => setHasToken(Boolean(t))).catch(() => {});
    setSyncState(controller.getDeviceVaultSyncState());
  }, [providerId]);

  // Connect the token, then pick the provider's (auto-created) default runner for
  // the draft and close — so the user lands back on the composer ready to send.
  const connect = async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const runner = await controller.connectEphemeralProvider(providerId, token.trim());
      setToken("");
      setHasToken(true);
      onKeysChanged();
      setSyncState(controller.getDeviceVaultSyncState());
      if (runner) setPendingRunner(runner);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  // Provider already connected: pick its default runner and return to composing.
  const useRunner = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const runner = await controller.defaultEphemeralRunner(providerId);
      if (runner) setPendingRunner(runner);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  if (catalog.hostedOnly) {
    return (
      <div className="settings-form">
        <Badge tone="accent">Server-managed provider</Badge>
        <p className="muted">{catalog.name} must be managed by Bivy's server so the machine is always deleted and billing stops.</p>
        <p className="muted small">Add it in Settings → Cloud machine profiles, then turn on “Run automations while I'm offline.”</p>
      </div>
    );
  }

  return (
    <div className="settings-form">
      {!hasToken ? (
        <>
          <p className="muted">{catalog.blurb}</p>
          <ol className="eph-steps">
            {catalog.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <div className="row-actions">
            {catalog.links.map((l) => (
              <a key={l.url} className="btn ghost" href={l.url} target="_blank" rel="noopener">{l.label}</a>
            ))}
          </div>
          <label className="field-label">{catalog.tokenLabel}</label>
          <input className="picker-search" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token" />
          <button className="btn primary" disabled={!token.trim() || saving} onClick={connect}>
            {saving ? "Connecting…" : "Connect"}
          </button>
          <p className="muted small">The token is end-to-end encrypted in your key vault, synced to your signed-in devices, and sent only to the selected provider. To run automations while you're offline, opt in from Settings → Cloud machine profiles.</p>
        </>
      ) : (
        <>
          <Badge tone="ok">✓ {catalog.name} connected</Badge>
          <p className="muted small">Your cloud profile is ready. Pick it and send your first message; Bivy starts the machine automatically. Adjust its region, size, or lifetime in Settings → Cloud machine profiles.</p>
          {syncState.phase !== "idle" && (
            <Badge role="status" tone={syncState.phase === "failed" ? "danger" : syncState.phase === "synced" ? "ok" : undefined}>
              {syncState.phase === "failed" ? `Credential sync pending: ${syncState.failure ?? "retry needed"}` : syncState.phase === "synced" ? "Credentials synced" : "Credential sync pending"}
              {syncState.phase === "failed" && <button className="btn ghost" onClick={() => controller.syncDeviceVault().then(() => setSyncState(controller.getDeviceVaultSyncState())).catch(() => setSyncState(controller.getDeviceVaultSyncState()))}>Retry</button>}
            </Badge>
          )}
          <div className="row-actions">
            <button className="btn primary" disabled={busy || catalog.hostedOnly} onClick={useRunner}>
              {busy ? "…" : catalog.hostedOnly ? "Device launch unavailable" : "Use this profile"}
            </button>
            <button
              className="btn danger-ghost"
              onClick={() => setConfirm({
                title: "Remove provider token?",
                message: `Forget the ${catalog.name} token on this device?`,
                action: () => controller.removeEphemeralToken(providerId).then(() => { setHasToken(false); onKeysChanged(); }),
              })}
            >
              Remove token
            </button>
          </div>
        </>
      )}
      {pendingRunner && (() => {
        const adapter = ephemeralAdapter(pendingRunner.provider);
        const size = adapter?.sizes.find((candidate) => candidate.id === pendingRunner.size);
        const cost = ephemeralCostHint(size, pendingRunner.ttlMinutes, adapter?.currency);
        const region = pendingRunner.region || adapter?.defaultRegion || "provider default";
        const teardown = pendingRunner.teardownOnAgentFinish
          ? "It will be destroyed when the agent finishes; the TTL remains a backstop."
          : `It will remain billable until its ${pendingRunner.ttlMinutes ?? "provider-default"}-minute TTL or manual teardown.`;
        return (
          <ConfirmDialog
            title="Use this billable machine profile?"
            message={`${catalog.name} will launch an isolated machine in ${region}${size ? ` (${size.label})` : ""} when you send your first message. ${cost || "The provider's live rate applies."} ${teardown}`}
            confirmLabel="Use profile"
            onCancel={() => setPendingRunner(null)}
            onConfirm={() => {
              controller.pickDraftEphemeralRunner(pendingRunner);
              setPendingRunner(null);
              onDone();
            }}
          />
        );
      })()}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
        />
      )}
      {err && <Badge tone="danger">{err}</Badge>}
    </div>
  );
}
