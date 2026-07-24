// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import {
  EPHEMERAL_PROVIDERS,
  ephemeralAdapter,
  type AccountMe,
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
  const [me, setMe] = useState<AccountMe | null>(null);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys);
  useEffect(() => {
    refreshKeys();
    controller.fetchMe().then(setMe).catch(() => {});
  }, []);

  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === provider);
  // undefined (self-host / still loading) reads as allowed; only a definite
  // `false` from the control plane gates the feature. The server enforces this
  // too (POST /api/ephemeral/exec) — this is UX so free users see the upsell
  // instead of a failed launch.
  const ephemeralAllowed = me?.entitlements?.ephemeralEnabled !== false;
  // Concurrency, not access: the plan allows launching, but only so many at once.
  // Configuring providers and machines stays unrestricted — we only block the
  // launch itself, and only while the account is already at its limit. Enroll is
  // the authoritative check (it runs before any cloud resource is created); this
  // just explains the ceiling before the user spends money finding it.
  const concurrentLimit = me?.entitlements?.ephemeralConcurrent;
  const running = me?.counts?.ephemeralRunning ?? 0;
  const atConcurrencyLimit = concurrentLimit !== undefined && running >= concurrentLimit;

  return (
    <Sheet
      title={catalog ? catalog.name : "Ephemeral machine"}
      onClose={onClose}
      headExtra={
        provider && ephemeralAllowed ? (
          <button className="sheet-back" onClick={() => setProvider(null)} aria-label="Back">
            ‹
          </button>
        ) : undefined
      }
    >
      {me && !ephemeralAllowed ? (
        <div className="picker-list">
          <p className="muted settings-intro">
            Quick ephemeral servers are a Pro feature. Upgrade to spin up a temporary cloud runner from your
            phone — or install Bivy on your own Mac or Linux machine, free forever.
          </p>
          <div className="row-actions">
            <button className="btn primary" onClick={() => controller.startCheckout().catch(() => {})}>
              Upgrade to Pro
            </button>
            <a className="btn ghost" href="/install.sh">
              Download installer
            </a>
          </div>
        </div>
      ) : !provider ? (
        <div className="picker-list">
          <p className="muted settings-intro">Bring your own cloud token to spin up a temporary node that self-destructs at its TTL.</p>
          {atConcurrencyLimit ? (
            <p className="muted settings-intro">
              Your plan runs {concurrentLimit} ephemeral machine{concurrentLimit === 1 ? "" : "s"} at a time, and
              you have {running} running. Destroy it to start another, or upgrade to run them in parallel.{" "}
              <button className="link-btn" onClick={() => controller.startCheckout().catch(() => {})}>
                Upgrade to Pro
              </button>
            </p>
          ) : null}
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
  const [msg, setMsg] = useState<string | null>(null);

  const refreshMachines = () =>
    controller.listEphemeralMachines().then((all) => setMachines(all.filter((m) => m.provider === providerId)));
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
    try {
      await controller.setEphemeralToken(providerId, token.trim());
      setToken("");
      setHasToken(true);
      onKeysChanged();
      setMsg("Token saved on this device.");
    } catch (e) {
      setMsg(String((e as Error).message || e));
    }
  };

  const launch = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await controller.launchEphemeral({ provider: providerId, region, size, ttlMinutes: ttl, repo: repo.trim() || undefined });
      setMsg("Launching — it will appear in the node list once it boots.");
      refreshMachines();
    } catch (e) {
      setMsg(String((e as Error).message || e));
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
          <button className="btn primary" disabled={!token.trim()} onClick={saveToken}>
            Save token
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
      {msg && <p className="muted">{msg}</p>}
      {machines.length > 0 && (
        <>
          <label className="field-label">Launched machines</label>
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
