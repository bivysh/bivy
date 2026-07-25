// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import {
  EPHEMERAL_PROVIDERS,
  ephemeralAdapter,
  type EphemeralMachine,
  type ProviderKeyInfo,
  type ProviderSize,
} from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";

const TTL_OPTIONS = [
  { v: 30, label: "30 min" },
  { v: 60, label: "1 hour" },
  { v: 180, label: "3 hours" },
  { v: 480, label: "8 hours" },
];

export function EphemeralSheet({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys);
  useEffect(() => {
    refreshKeys();
  }, []);

  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === provider);

  // Ephemeral cloud runners are included on every plan (each launch draws from
  // the shared weekly run cap), so there's no upgrade gate here.
  return (
    <Sheet
      title={catalog ? catalog.name : "Ephemeral machine"}
      onClose={onClose}
      headExtra={
        provider ? (
          <button className="sheet-back" onClick={() => setProvider(null)} aria-label="Back">
            ‹
          </button>
        ) : undefined
      }
    >
      {!provider ? (
        <div className="picker-list">
          <p className="muted settings-intro">Bring your own cloud token to spin up a temporary node that self-destructs at its TTL.</p>
          {EPHEMERAL_PROVIDERS.map((p) => {
            const k = keys.find((x) => x.id === p.id);
            return (
              <PickerItem
                key={p.id}
                title={p.name}
                meta={p.blurb}
                right={k?.configured ? <span className="chip ok">Token saved</span> : undefined}
                onClick={() => setProvider(p.id)}
              />
            );
          })}
        </div>
      ) : (
        <ProviderPanel providerId={provider} onKeysChanged={refreshKeys} />
      )}
    </Sheet>
  );
}

function ProviderPanel({ providerId, onKeysChanged }: { providerId: string; onKeysChanged: () => void }) {
  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === providerId)!;
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const adapter = ephemeralAdapter(providerId)!;
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [region, setRegion] = useState(adapter.defaultRegion);
  const [sizes, setSizes] = useState<ProviderSize[]>(adapter.sizes);
  const [size, setSize] = useState(adapter.defaultSize);
  const [ttl, setTtl] = useState(60);
  const [repo, setRepo] = useState("");
  const [machines, setMachines] = useState<EphemeralMachine[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Split from the old single `msg`, which rendered a launch failure and a
  // launch success in the same muted <p> — a failure read like a neutral
  // status line (#140). `err` gets the queue panel's `chip err` treatment.
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refreshMachines = () =>
    controller.listEphemeralMachines().then((all) => setMachines(all.filter((m) => m.provider === providerId)));
  // Poll while a machine is still booting so its status/IP update without the
  // user having to close and reopen the sheet (#140) — stops once nothing is
  // in a transitional state.
  useEffect(() => {
    if (!machines.some((m) => m.status === "starting")) return;
    const t = setInterval(refreshMachines, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines]);
  useEffect(() => {
    controller.getEphemeralToken(providerId).then((t) => setHasToken(Boolean(t)));
    // Pre-fill from the preferences the user saved in Settings → Ephemeral
    // machines. Additive: everything stays editable per launch; a missing
    // preference just leaves the adapter default in place.
    controller.getEphemeralPrefs(providerId).then((p) => {
      if (p.region) setRegion(p.region);
      if (p.size) setSize(p.size);
      if (typeof p.ttlMinutes === "number") setTtl(p.ttlMinutes);
      if (p.repo) setRepo(p.repo);
    }).catch(() => {});
    refreshMachines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Once a token is saved, replace the static catalog with the provider's live,
  // non-deprecated sizes for the chosen region so neither a retired plan nor one
  // unavailable in that region can be offered. Re-runs when the region changes.
  useEffect(() => {
    if (!hasToken) return;
    let active = true;
    controller
      .listEphemeralSizes(providerId, region)
      .then((list) => {
        if (!active || !list.length) return;
        setSizes(list);
        setSize((cur) =>
          list.some((s) => s.id === cur)
            ? cur
            : list.some((s) => s.id === adapter.defaultSize)
              ? adapter.defaultSize
              : (list[0]?.id ?? adapter.defaultSize),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, providerId, region]);

  const saveToken = async () => {
    // token isn't cleared until the await resolves, so without this guard a
    // second click before then fires another save (#140).
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      await controller.setEphemeralToken(providerId, token.trim());
      setToken("");
      setHasToken(true);
      onKeysChanged();
      setMsg("Token saved on this device.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  const launch = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await controller.launchEphemeral({ provider: providerId, region, size, ttlMinutes: ttl, repo: repo.trim() || undefined });
      setMsg("Launching — it will appear in the node list once it boots.");
      refreshMachines();
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
            {catalog.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <div className="row-actions">
            {catalog.links.map((l) => (
              <a key={l.url} className="btn ghost" href={l.url} target="_blank" rel="noopener">
                {l.label}
              </a>
            ))}
          </div>
          <label className="field-label">{catalog.tokenLabel}</label>
          <input className="picker-search" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token" />
          <button className="btn primary" disabled={!token.trim() || saving} onClick={saveToken}>
            {saving ? "Saving…" : "Save token"}
          </button>
        </>
      ) : (
        <>
          <div className="eph-row">
            <label className="field-label">Region</label>
            <select className="picker-search" value={region} onChange={(e) => setRegion(e.target.value)}>
              {adapter.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="eph-row">
            <label className="field-label">Server type</label>
            <select className="picker-search" value={size} onChange={(e) => setSize(e.target.value)}>
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="eph-row">
            <label className="field-label">Auto-destroy after</label>
            <select className="picker-search" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <label className="field-label">Repo (optional, owner/name)</label>
          <input className="picker-search" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={launch}>
              {busy ? "Launching…" : "Launch machine"}
            </button>
            <button
              className="btn danger-ghost"
              onClick={() => setConfirm({
                title: "Remove provider token?",
                message: `Forget the ${catalog.name} token on this device?`,
                action: () => controller.removeEphemeralToken(providerId).then(() => {
                  setHasToken(false);
                  onKeysChanged();
                }),
              })}
            >
              Remove token
            </button>
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label || "Remove"}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
        />
      )}
      {err && <span className="chip err">{err}</span>}
      {msg && <p className="muted">{msg}</p>}
      {machines.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <label className="field-label">Launched machines</label>
            <button type="button" className="link-btn" onClick={refreshMachines}>Refresh</button>
          </div>
          <div className="picker-list">
            {machines.map((m) => (
              <PickerItem
                key={m.id}
                title={m.name || m.id}
                meta={[m.region, m.ip, m.repo, m.status].filter(Boolean).join(" · ")}
                right={
                  <button
                    type="button"
                    className="picker-action danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirm({
                        title: "Destroy machine?",
                        message: `Destroy ${m.name || m.id} now? This can't be undone.`,
                        label: "Destroy",
                        action: () => controller.destroyEphemeral(m).then(refreshMachines),
                      });
                    }}
                  >
                    Destroy
                  </button>
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
