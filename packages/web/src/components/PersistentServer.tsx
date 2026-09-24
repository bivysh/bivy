// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { ephemeralAdapter, ephemeralCatalogEntry, formatEphemeralPrice, type EphemeralMachine, type ProviderSize } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { ConfirmDialog } from "./AppDialog.js";

/** Explicit machine purchase, not a profile that purchases on every session. */
export function PersistentServerPanel({ providerId, onDone }: { providerId: string; onDone: () => void }) {
  const adapter = ephemeralAdapter(providerId)!;
  const catalog = ephemeralCatalogEntry(providerId)!;
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState(adapter.defaultRegion);
  const [sizes, setSizes] = useState<ProviderSize[]>([]);
  const [size, setSize] = useState("");
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("My development server");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [machine, setMachine] = useState<EphemeralMachine | null>(null);
  const launching = useRef(false);

  useEffect(() => {
    let active = true;
    void controller.getEphemeralToken(providerId).then(value => {
      if (active) setConnected(Boolean(value));
    }).catch(() => { if (active) setError("Could not read your provider credential. Reconnect it below."); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [providerId]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    setLoadingSizes(true);
    setSizes([]);
    setSize("");
    setError(null);
    void controller.listEphemeralSizes(providerId, region).then(rows => {
      if (!active) return;
      const available = rows.filter(row => row.architecture === "x86_64" && (row.memoryMiB ?? 0) >= 4096)
        .sort((a, b) => (a.memoryMiB ?? 0) - (b.memoryMiB ?? 0) || (a.vcpus ?? 0) - (b.vcpus ?? 0));
      setSizes(available);
      const recommended = available.find(row => (row.memoryMiB ?? 0) >= 8192 && (row.vcpus ?? 0) >= 4);
      setSize((recommended ?? available[0])?.id ?? "");
    }).catch(() => { if (active) setError("Could not load server sizes. Try again."); })
      .finally(() => { if (active) setLoadingSizes(false); });
    return () => { active = false; };
  }, [connected, providerId, region, reload]);

  const saveToken = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.saveCloudProviderToken(providerId, token.trim());
      setToken("");
      setConnected(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const create = async () => {
    setConfirm(false);
    if (launching.current) return;
    launching.current = true;
    setAttempted(true);
    setBusy(true);
    setError(null);
    try {
      const created = await controller.launchEphemeral({
        provider: providerId, lifecycle: "persistent", region, size, name: name.trim(),
        // The server is reusable; repo and credentials are configured after
        // connection, not inherited from whichever draft happened to be open.
        repo: "", githubToken: "", onProgress: setProgress,
      });
      setMachine(created);
      setProgress(`Server created (ID ${created.id}). Installation may take a few minutes. It will appear in your machine list when online.`);
    } catch (cause) {
      setProgress("");
      setError(`${cause instanceof Error ? cause.message : String(cause)} Check your provider console before trying again: a server may have been created and may already be billing.`);
    } finally { setBusy(false); }
  };

  const connect = async () => {
    if (!machine?.nodeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.connectToNode(machine.nodeId, 120_000);
      onDone();
    } catch {
      setError("Your server is not ready yet. Try connecting again, or inspect cloud-init and bivy.service in the provider console. No replacement server was created.");
    } finally { setBusy(false); }
  };

  const selected = sizes.find(row => row.id === size);
  const price = selected?.pricePerHour;
  const cost = price ? `Estimated compute: ${formatEphemeralPrice(price * 730, adapter.currency)}/month at 730 hours.` : "Your provider's current rates apply.";
  const locked = busy || attempted;

  return <div className="settings-form">
    <p className="muted">Your own always-on server. Sessions reuse it; installed tools and files stay on its disk. You pay {catalog.name} directly.</p>
    {checking ? <p role="status">Checking saved credentials…</p> : !connected ? <>
      <ol className="eph-steps">
        <li>Create a dedicated project in your cloud account.</li>
        <li>In Security → API Tokens, generate a Read & Write token for that project.</li>
        <li>Paste it below. Check your CPU and Primary IP quotas before creating a server.</li>
      </ol>
      <label className="field-label" htmlFor="persistent-provider-token">{catalog.tokenLabel}</label>
      <input id="persistent-provider-token" className="picker-search" type="password" autoComplete="off" value={token} disabled={busy} onChange={event => setToken(event.target.value)} />
      <button className="btn primary" disabled={!token.trim() || busy} onClick={() => void saveToken()}>{busy ? "Checking credential…" : "Connect provider"}</button>
      <p className="muted small">Stored in your encrypted device vault and synced to signed-in devices. Provisioning requests pass through Bivy's API relay to your provider. The token is not installed on the server. Normal server operation does not require it; you can revoke it in the provider console after setup.</p>
    </> : !machine && !attempted ? <>
      <label className="field-label" htmlFor="persistent-server-name">Server name</label>
      <input id="persistent-server-name" className="picker-search" maxLength={80} value={name} disabled={locked} onChange={event => setName(event.target.value)} />
      <label className="field-label" htmlFor="persistent-server-region">Region</label>
      <select id="persistent-server-region" className="picker-search" value={region} disabled={locked} onChange={event => setRegion(event.target.value)}>
        {adapter.regions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <label className="field-label" htmlFor="persistent-server-size">Server size</label>
      <select id="persistent-server-size" className="picker-search" value={size} disabled={locked || loadingSizes || !sizes.length} onChange={event => setSize(event.target.value)}>
        {loadingSizes ? <option value="">Loading sizes…</option> : !sizes.length ? <option value="">No compatible sizes available</option> : sizes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      {!loadingSizes && !sizes.length && <button className="btn ghost" onClick={() => setReload(value => value + 1)}>Retry sizes</button>}
      <p className="muted small">8 GB RAM is recommended. 4 GB is a budget option for lighter work; builds and tests may run out of memory.</p>
      <p role="status">{loadingSizes ? "Checking available sizes…" : cost}</p>
      <p className="muted small">IPs, backups, traffic and taxes may add cost. Provider monthly caps may lower this estimate. Final availability and pricing are confirmed by the provider.</p>
      <button className="btn primary" disabled={locked || loadingSizes || !selected || !name.trim()} onClick={() => setConfirm(true)}>Review server cost</button>
    </> : null}
    {progress && <p role="status">{progress}</p>}
    {machine && <button className="btn primary" disabled={busy} onClick={() => void connect()}>{busy ? "Waiting for your server…" : "Connect to server"}</button>}
    {error && <p className="banner inline" data-tone="danger" role="alert">{error}</p>}
    <p className="muted small">No automatic expiry. Closing Bivy, disconnecting, or powering off does not stop provider charges. Delete the server in your provider console to stop server billing.</p>
    <details>
      <summary>Server care and data protection</summary>
      <p className="muted small">You manage OS updates and backups. Bivy does not configure managed backups. Keep recovery copies before modifying or deleting the server; a persistent disk is not a backup.</p>
    </details>
    <div className="row-actions">{catalog.links.map(link => <a key={link.url} className="btn ghost" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}</div>
    {confirm && <ConfirmDialog
      title="Create an always-on server?"
      message={`${catalog.name} · ${region} · ${selected?.label ?? size}. ${cost} Additional provider charges may apply. This creates one persistent server in your own account. It remains billable until you explicitly delete it. Keep this page open until creation finishes.`}
      confirmLabel="Create billable server"
      onCancel={() => setConfirm(false)}
      onConfirm={() => void create()}
    />}
  </div>;
}
