// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { EPHEMERAL_PROVIDERS, ephemeralAdapter, ephemeralCostHint, type EphemeralNodeConfig, type ProviderKeyInfo } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";

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
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys).catch(() => {});
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
              : "Pick a provider and paste a token. Connecting one adds a runner you can pick in the machine menu."}
          </p>
          {EPHEMERAL_PROVIDERS.map((p) => {
            const k = keys.find((x) => x.id === p.id);
            return (
              <PickerItem
                key={p.id}
                title={p.name}
                meta={p.blurb}
                right={k?.configured ? <span className="chip ok">Connected</span> : undefined}
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

  useEffect(() => {
    controller.getEphemeralToken(providerId).then((t) => setHasToken(Boolean(t))).catch(() => {});
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
          <p className="muted small">The token stays on this device — Bivy never stores it. You can fine-tune region, size, and auto-destroy later in Settings → Ephemeral machines.</p>
        </>
      ) : (
        <>
          <p className="chip ok">✓ {catalog.name} connected</p>
          <p className="muted small">A default runner is ready. Pick it and send your first message to launch a machine — no launch button. Adjust its region / size / TTL anytime in Settings → Ephemeral machines.</p>
          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={useRunner}>{busy ? "…" : "Use this runner"}</button>
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
            title="Use this billable runner?"
            message={`${catalog.name} will launch a machine in ${region}${size ? ` (${size.label})` : ""} when you send your first message. ${cost || "The provider's live rate applies."} ${teardown}`}
            confirmLabel="Use runner"
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
      {err && <span className="chip err">{err}</span>}
    </div>
  );
}
