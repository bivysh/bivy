// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import {
  EPHEMERAL_PROVIDERS,
  ephemeralAdapter,
  ephemeralCostHint,
  type EphemeralMachine,
  type EphemeralModelKeyInfo,
  type EphemeralSetup,
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

export function EphemeralSheet({ onClose, setupId, firstRun = false }: { onClose: () => void; setupId?: string; firstRun?: boolean }) {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [setups, setSetups] = useState<EphemeralSetup[]>([]);
  const [selectedSetup, setSelectedSetup] = useState<EphemeralSetup | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys);
  useEffect(() => {
    refreshKeys();
    controller.listEphemeralSetups().then((rows) => {
      setSetups(rows);
      const selected = setupId ? rows.find((s) => s.id === setupId) : undefined;
      if (selected) {
        setSelectedSetup(selected);
        setProvider(selected.provider);
      }
    });
  }, [setupId]);

  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === provider);

  // Ephemeral cloud runners are included on every plan (each launch draws from
  // the shared weekly run cap), so there's no upgrade gate here.
  return (
    <Sheet
      title={catalog ? catalog.name : "Ephemeral machine"}
      onClose={onClose}
      headExtra={
        provider ? (
          <button className="sheet-back" onClick={() => { setProvider(null); setSelectedSetup(null); }} aria-label="Back">
            ‹
          </button>
        ) : undefined
      }
    >
      {!provider ? (
        <div className="picker-list">
          <p className="muted settings-intro">Launch a saved node setup, or configure an ad-hoc temporary node that self-destructs at its TTL.</p>
          {setups.length > 0 && <div className="node-menu-head">Saved setups</div>}
          {setups.map((setup) => {
            const p = EPHEMERAL_PROVIDERS.find((item) => item.id === setup.provider);
            return (
              <PickerItem
                key={setup.id}
                title={setup.name}
                meta={[p?.name, setup.region, setup.size, setup.teardownOnAgentFinish ? "until agent finishes" : setup.ttlMinutes ? `${setup.ttlMinutes} min` : null].filter(Boolean).join(" · ")}
                right={<span className="chip">Offline</span>}
                onClick={() => { setSelectedSetup(setup); setProvider(setup.provider); }}
              />
            );
          })}
          {setups.length > 0 && <div className="node-menu-head">Providers</div>}
          {EPHEMERAL_PROVIDERS.map((p) => {
            const k = keys.find((x) => x.id === p.id);
            return (
              <PickerItem
                key={p.id}
                title={p.name}
                meta={p.blurb}
                right={k?.configured ? <span className="chip ok">Token saved</span> : undefined}
                onClick={() => { setSelectedSetup(null); setProvider(p.id); }}
              />
            );
          })}
        </div>
      ) : (
        <ProviderPanel providerId={provider} setup={selectedSetup} onKeysChanged={refreshKeys} firstRun={firstRun} />
      )}
    </Sheet>
  );
}

function ProviderPanel({ providerId, setup, onKeysChanged, firstRun }: { providerId: string; setup: EphemeralSetup | null; onKeysChanged: () => void; firstRun: boolean }) {
  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === providerId)!;
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const adapter = ephemeralAdapter(providerId)!;
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [region, setRegion] = useState(adapter.defaultRegion);
  const [sizes, setSizes] = useState<ProviderSize[]>(adapter.sizes);
  const [size, setSize] = useState(adapter.defaultSize);
  const [ttl, setTtl] = useState(60);
  const [teardownOnAgentFinish, setTeardownOnAgentFinish] = useState(false);
  const [machines, setMachines] = useState<EphemeralMachine[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelKeys, setModelKeys] = useState<EphemeralModelKeyInfo[]>([]);
  const [modelProvider, setModelProvider] = useState("anthropic");
  const [modelKey, setModelKey] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [savingGithub, setSavingGithub] = useState(false);
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
    controller.listEphemeralModelKeys().then(setModelKeys).catch(() => {});
    controller.getGithubTaskToken().then((t) => setHasGithubToken(Boolean(t))).catch(() => {});
    // Pre-fill from the preferences the user saved in Settings → Ephemeral
    // machines. Additive: everything stays editable per launch; a missing
    // preference just leaves the adapter default in place.
    const loadPrefs = setup ? Promise.resolve(setup) : controller.getEphemeralPrefs(providerId);
    loadPrefs.then((p) => {
      if (p.region) setRegion(p.region);
      if (p.size) setSize(p.size);
      if (typeof p.ttlMinutes === "number") setTtl(p.ttlMinutes);
      setTeardownOnAgentFinish(p.teardownOnAgentFinish === true);
    }).catch(() => {});
    refreshMachines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, setup]);

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

  const saveModelKey = async () => {
    if (!modelProvider.trim() || !modelKey.trim() || savingModel) return;
    setSavingModel(true);
    setErr(null);
    try {
      await controller.setEphemeralModelKey(modelProvider.trim(), modelKey.trim());
      setModelKey("");
      setModelKeys(await controller.listEphemeralModelKeys());
      setMsg("Model key saved on this device.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSavingModel(false);
    }
  };

  const saveGithubToken = async () => {
    if (!githubToken.trim() || savingGithub) return;
    setSavingGithub(true);
    setErr(null);
    try {
      await controller.setGithubTaskToken(githubToken.trim());
      setGithubToken("");
      setHasGithubToken(true);
      setMsg("GitHub token saved on this device.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSavingGithub(false);
    }
  };

  // Suspend-to-zero providers (Fly Sprites) keep the machine and self-suspend
  // when idle — so the TTL self-destruct and "destroy when the agent finishes"
  // controls don't apply; a suspend explainer replaces them.
  const suspendsWhenIdle = adapter.suspendsWhenIdle === true;

  const launch = async () => {
    if (firstRun && modelKeys.length === 0) {
      setErr("Add a model API key before launching your first runner.");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await controller.launchEphemeral({
        provider: providerId,
        region,
        size,
        ttlMinutes: suspendsWhenIdle ? undefined : ttl,
        teardownOnAgentFinish: suspendsWhenIdle ? false : teardownOnAgentFinish,
        name: setup?.name,
        setupId: setup?.id,
      });
      setMsg(suspendsWhenIdle
        ? "Launching — it'll appear in the node list once it boots, then suspend to ~$0 when idle."
        : "Launching — it will appear in the node list once it boots.");
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
          {firstRun && <h4 className="settings-subhead">1. Connect your cloud provider</h4>}
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
          {firstRun && (
            <div className="first-run-credentials">
              <h4 className="settings-subhead">2. Give the runner model access</h4>
              <p className="muted small">Required for your first task. The key stays on this device and is sent to the runner only after its encrypted connection is online.</p>
              {modelKeys.length > 0 ? (
                <p className="chip ok">✓ Model key ready ({modelKeys.map((k) => k.provider).join(", ")})</p>
              ) : (
                <>
                  <label className="field-label">Model provider</label>
                  <select className="picker-search" value={modelProvider} onChange={(e) => setModelProvider(e.target.value)}>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="google">Google</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="xai">xAI</option>
                  </select>
                  <label className="field-label">Model API key</label>
                  <input className="picker-search" type="password" autoComplete="off" value={modelKey} onChange={(e) => setModelKey(e.target.value)} placeholder="Paste API key" />
                  <button className="btn" disabled={!modelKey.trim() || savingModel} onClick={saveModelKey}>
                    {savingModel ? "Saving…" : "Save model key"}
                  </button>
                </>
              )}

              <h4 className="settings-subhead">3. Connect GitHub</h4>
              <p className="muted small">Optional for a no-repo chat. For repository work, create a fine-grained token with Contents and Pull requests read/write access.</p>
              {hasGithubToken ? (
                <p className="chip ok">✓ GitHub access ready</p>
              ) : (
                <>
                  <a className="btn ghost" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained GitHub token</a>
                  <label className="field-label">GitHub token</label>
                  <input className="picker-search" type="password" autoComplete="off" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="Paste GitHub token" />
                  <button className="btn" disabled={!githubToken.trim() || savingGithub} onClick={saveGithubToken}>
                    {savingGithub ? "Saving…" : "Save GitHub token"}
                  </button>
                </>
              )}
              <h4 className="settings-subhead">4. Choose and launch the runner</h4>
            </div>
          )}
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
          {!suspendsWhenIdle && (
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
          )}
          {(() => {
            const selected = sizes.find((s) => s.id === size);
            // Suspend-to-zero: only the hourly rate is meaningful (no TTL ceiling),
            // and it's ~$0 while idle. Pass no TTL to get just the "≈ $x/hr" part.
            const hint = ephemeralCostHint(selected, suspendsWhenIdle ? undefined : ttl, adapter.currency);
            if (!hint) return null;
            return suspendsWhenIdle
              ? <p className="muted small">{hint} while active · ~$0 while suspended · billed by {catalog.name}, not Bivy</p>
              : <p className="muted small">{hint} · billed by {catalog.name}, not Bivy</p>;
          })()}
          {suspendsWhenIdle ? (
            <p className="muted small">Keeps its memory: suspends to ~$0 when idle and resumes with everything intact. Reopen its session from the node list to wake it. Destroy it manually when you're done.</p>
          ) : (
            <>
              <label className="field-label">Teardown</label>
              <label className="checkbox-row">
                <input type="checkbox" checked={teardownOnAgentFinish} onChange={(e) => setTeardownOnAgentFinish(e.target.checked)} />
                <span>Destroy when the agent finishes <span className="muted small">(TTL remains a safety fallback; requires this device to stay online)</span></span>
              </label>
            </>
          )}
          <p className="muted small">The machine pre-clones the repo you pick in the new-session composer.</p>
          <div className="row-actions">
            <button className="btn primary" disabled={busy || (firstRun && modelKeys.length === 0)} onClick={launch}>
              {busy ? "Launching…" : firstRun ? "Launch my first runner" : "Launch machine"}
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
                        action: () => controller.destroyEphemeral(m).then(refreshMachines).catch((e) => setErr(String((e as Error)?.message || e))),
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
