// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useMemo, useState } from "react";
import { modelAuthApiKeyProvider, type AppState, type CentralGithubAppView } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { ProviderConnectForm } from "./ProviderConnect.js";

export function FirstRunOnboarding({ state, onDone }: { state: AppState; onDone: () => void }) {
  const [github, setGithub] = useState<CentralGithubAppView | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [claim, setClaim] = useState<Awaited<ReturnType<typeof controller.createNodeClaim>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, setManagedAuthRunner] = useState(() => sessionStorage.getItem("bivy:managed-auth-runner") === "1");
  const [verifiedCredential, setVerifiedCredential] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const configuredProviders = useMemo(() => state.catalogs.providers.filter((provider) => provider.configured), [state.catalogs.providers]);
  const [providerId, setProviderId] = useState("anthropic");
  const availableAgents = useMemo(
    () => state.catalogs.runtimes.filter((runtime) => String((runtime as { status?: string }).status ?? "available") === "available"),
    [state.catalogs.runtimes],
  );
  const selectedAgentId = state.catalogs.selectedAgentId || availableAgents[0]?.id || "";
  const selectedRuntime = availableAgents.find((runtime) => runtime.id === selectedAgentId);
  const providerOptions = useMemo(() => {
    const live = state.catalogs.providers.length > 0
      ? state.catalogs.providers
      : [
          { id: "anthropic", name: "Anthropic / Claude" },
          { id: "openai-codex", name: "OpenAI / Codex" },
          { id: "openai", name: "OpenAI API" },
        ];
    const declared = selectedRuntime?.credentialRequirements?.providers ?? [];
    if (declared.length === 0) return live;
    const matching = live.filter((provider) => declared.includes(provider.id) || declared.includes(modelAuthApiKeyProvider(provider.id)));
    // Runtime switches and provider-list refreshes are independent relay events;
    // keep the live list during that brief mismatch rather than painting empty.
    return matching.length > 0 ? matching : live;
  }, [state.catalogs.providers, selectedRuntime]);
  const apiKeyProvider = modelAuthApiKeyProvider(providerId);
  const activeCredential = state.settings.credentialRecords.find(
    (record) => record.provider === providerId || record.provider === apiKeyProvider,
  );
  const selectedProviderConfigured = Boolean(
    state.catalogs.providers.find((provider) => provider.id === providerId)?.configured || activeCredential,
  );
  const activeCredentialKey = activeCredential ? `${activeCredential.provider}:${activeCredential.label}` : null;
  const credentialVerified = !activeCredential?.testable
    || activeCredential.lastVerifiedOk === true
    || (activeCredentialKey !== null && activeCredentialKey === verifiedCredential);
  const hasMachine = Boolean(state.connection.currentNodeId);
  const machineOnline = hasMachine && state.connection.status === "online";
  const hasGithub = Boolean(github?.installations.length);
  const managedAvailable = github?.managedComputeAvailable === true;

  const refreshGithub = () => controller.centralGithubApp().then(setGithub).catch((error) => setGithubError(String((error as Error)?.message || error)));
  useEffect(() => {
    void refreshGithub();
    const onFocus = () => void refreshGithub();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (hasMachine) {
      controller.listProviders();
      controller.listCredentialRecords();
    }
  }, [hasMachine]);
  useEffect(() => {
    if (configuredProviders.length && !configuredProviders.some((provider) => provider.id === providerId)) {
      setProviderId(configuredProviders[0]!.id);
      return;
    }
    if (state.catalogs.providers.length && !state.catalogs.providers.some((provider) => provider.id === providerId)) {
      setProviderId(state.catalogs.providers[0]!.id);
    }
  }, [configuredProviders, providerId, state.catalogs.providers]);
  useEffect(() => {
    if (!claim) return;
    const timer = window.setInterval(() => {
      void controller.listNodeClaims().then((claims) => {
        if (claims.find((item) => item.id === claim.id)?.status !== "pending") setClaim(null);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [claim]);

  const step = !github ? "loading" : github.configured && !hasGithub ? "github" : !machineOnline ? "machine"
    : !selectedProviderConfigured ? "provider"
      : managedAvailable && !activeCredential?.unattended ? "custody"
        : !credentialVerified ? "verify" : "ready";
  const startGithubInstall = useCallback(async () => {
    setBusy(true); setGithubError(null);
    try {
      const install = await controller.createCentralGithubInstall("/?onboarding=github");
      window.location.assign(install.installUrl);
    } catch (error) {
      setGithubError(String((error as Error)?.message || error));
      setBusy(false);
    }
  }, []);
  const startManagedAuthRunner = useCallback(async () => {
    setBusy(true); setGithubError(null);
    try {
      await controller.createManagedAuthRunner();
      sessionStorage.setItem("bivy:managed-auth-runner", "1");
      setManagedAuthRunner(true);
      await controller.refreshNodes();
    } catch (error) {
      setGithubError(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  }, []);
  const enableManagedCredential = useCallback(async () => {
    if (!activeCredential) return;
    setBusy(true); setGithubError(null);
    try {
      await controller.setCredentialUnattended(activeCredential.provider, activeCredential.label, true);
      controller.listCredentialRecords();
    } catch (error) {
      setGithubError(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  }, [activeCredential]);
  const verifyActiveCredential = useCallback(async () => {
    if (!activeCredential || !activeCredential.testable) return;
    setBusy(true); setGithubError(null);
    try {
      const result = await controller.testCredential(activeCredential.provider, activeCredential.label);
      if (!result.ok) throw new Error(result.reason || "The provider rejected this credential.");
      setVerifiedCredential(`${activeCredential.provider}:${activeCredential.label}`);
      controller.listCredentialRecords();
    } catch (error) {
      setGithubError(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  }, [activeCredential]);
  // GitHub signup flows directly into App installation. A session-scoped guard
  // prevents a cancel/denial redirect from bouncing the browser back forever;
  // the explicit button remains available for retry.
  useEffect(() => {
    if (step !== "github" || sessionStorage.getItem("bivy:github-install-attempted")) return;
    sessionStorage.setItem("bivy:github-install-attempted", "1");
    void startGithubInstall();
  }, [step, startGithubInstall]);
  // Managed hosting is the default no-install path. Start its short-lived auth
  // runner as soon as GitHub setup completes; policy remains the abuse/cost gate.
  // A session guard prevents retries on every render while the explicit button
  // remains available after a transient failure.
  useEffect(() => {
    if (step !== "machine" || hasMachine || !managedAvailable || sessionStorage.getItem("bivy:managed-auth-attempted")) return;
    sessionStorage.setItem("bivy:managed-auth-attempted", "1");
    void startManagedAuthRunner();
  }, [step, hasMachine, managedAvailable, startManagedAuthRunner]);
  useEffect(() => {
    if (step !== "custody" || !activeCredentialKey || sessionStorage.getItem(`bivy:managed-credential:${activeCredentialKey}`)) return;
    sessionStorage.setItem(`bivy:managed-credential:${activeCredentialKey}`, "attempted");
    void enableManagedCredential();
  }, [step, activeCredentialKey, enableManagedCredential]);
  useEffect(() => {
    if (step !== "verify" || !activeCredentialKey || sessionStorage.getItem(`bivy:credential-verified:${activeCredentialKey}`)) return;
    sessionStorage.setItem(`bivy:credential-verified:${activeCredentialKey}`, "attempted");
    void verifyActiveCredential();
  }, [step, activeCredentialKey, verifyActiveCredential]);
  useEffect(() => {
    if (step !== "ready" || finishing || githubError) return;
    setFinishing(true); setGithubError(null);
    const target = managedAvailable
      ? controller.ensureManagedSessionDefaults()
      : controller.listEphemeralConfigs().then((configs) => configs.find((config) => config.computeSource === "managed") ?? null);
    void target
      .then((config) => {
        if (config) controller.pickDraftEphemeralRunner(config);
        sessionStorage.removeItem("bivy:managed-auth-runner");
        onDone();
      })
      .catch((error) => {
        setGithubError(String((error as Error)?.message || error));
        setFinishing(false);
      });
  }, [finishing, githubError, managedAvailable, onDone, step]);

  return (
    <div className="connect-runner">
      <div>
        <p className="connect-eyebrow">Welcome to Bivy</p>
        <h2 className="connect-title">Set up your first session</h2>
        <p className="connect-sub">Connect GitHub and a model provider. Your first session will open on Bivy Cloud.</p>
      </div>
      <ol className="readiness-checks" aria-label="Onboarding progress">
        <li className={`readiness-check ${hasGithub ? "state-passed" : "state-pending"}`}><span className={`readiness-mark ${hasGithub ? "mark-passed" : ""}`}>{hasGithub ? "✓" : "1"}</span><span><span className="readiness-label">GitHub App</span><span className="readiness-detail"> · repository access</span></span></li>
        <li className={`readiness-check ${selectedProviderConfigured && credentialVerified ? "state-passed" : "state-pending"}`}><span className={`readiness-mark ${selectedProviderConfigured && credentialVerified ? "mark-passed" : ""}`}>{selectedProviderConfigured && credentialVerified ? "✓" : "2"}</span><span><span className="readiness-label">Model provider</span><span className="readiness-detail"> · sign in or add an API key</span></span></li>
      </ol>

      {githubError && <div className="banner inline" data-tone="danger" role="alert">{githubError}</div>}
      {step === "loading" && <p className="muted">Checking your account…</p>}
      {step === "github" && (
        <section className="settings-section">
          <h3>Install the Bivy GitHub App</h3>
          <p className="muted">Choose the repositories Bivy may use. The installation target must match the GitHub identity you used to sign in.</p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void startGithubInstall()}>{busy ? "Opening GitHub…" : "Continue to GitHub"}</button>
          {githubError?.includes("Sign in with GitHub again") && <a className="btn" href="/auth/github/start?return=%2F%3Fonboarding%3Dgithub">Verify GitHub identity</a>}
        </section>
      )}
      {step === "machine" && (
        <section className="settings-section">
          <h3>{managedAvailable ? "Preparing secure provider sign-in" : "Connect a Machine"}</h3>
          {hasMachine ? (
            <p className="muted">Your secure sign-in environment is starting and connecting…</p>
          ) : (
            <>
              {managedAvailable && <>
                <p className="muted">Bivy is starting a short-lived sign-in environment. It cannot run tasks, expires after 15 minutes, and does not consume a trial session.</p>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void startManagedAuthRunner()}>{busy ? "Starting…" : "Try managed setup again"}</button>
              </>}
              <p className="muted small">{managedAvailable ? "Prefer your own computer? Enroll macOS/Linux with a one-time command:" : "Enroll your macOS/Linux Machine with a one-time command:"}</p>
              {!claim?.command ? <button type="button" className="btn" disabled={busy} onClick={() => {
                setBusy(true);
                controller.createNodeClaim().then(setClaim).catch((error) => setGithubError(String((error as Error)?.message || error))).finally(() => setBusy(false));
              }}>{busy ? "Creating…" : "Create personal install command"}</button> : <div className="repo-connect-command"><code>{claim.command}</code><button type="button" className={`repo-connect-copy${copied ? " is-copied" : ""}`} onClick={() => void navigator.clipboard.writeText(claim.command || "").then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copied" : "Copy"}</button></div>}
            </>
          )}
        </section>
      )}
      {step === "provider" && (
        <section className="settings-section">
          <h3>Sign in with a model provider</h3>
          <p className="muted">Sign in or add an API key. Bivy encrypts the credential for your account and makes it available only when your Bivy Cloud Machine starts.</p>
          <label className="field-label" htmlFor="onboarding-agent">Agent</label>
          <select id="onboarding-agent" className="picker-search" value={selectedAgentId} onChange={(event) => {
            const runtime = availableAgents.find((candidate) => candidate.id === event.target.value);
            if (runtime) controller.chooseAgent(runtime);
          }}>
            {availableAgents.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.name || runtime.id}</option>)}
          </select>
          <label className="field-label" htmlFor="onboarding-provider">Authentication provider</label>
          <select id="onboarding-provider" className="picker-search" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
          </select>
          <ProviderConnectForm state={state} providerId={providerId} apiKeyProvider={apiKeyProvider !== providerId ? apiKeyProvider : undefined} />
        </section>
      )}
      {step === "custody" && (
        <section className="settings-section">
          <h3>Securing your provider login</h3>
          <p className="muted" role="status">Encrypting this credential for Bivy Cloud. It remains isolated from GitHub and other users, and can be revoked in Providers &amp; credentials.</p>
          {githubError && <button type="button" className="btn" disabled={busy || !activeCredential} onClick={() => void enableManagedCredential()}>{busy ? "Encrypting…" : "Try again"}</button>}
        </section>
      )}
      {step === "verify" && (
        <section className="settings-section">
          <h3>Verify provider access</h3>
          <p className="muted">Bivy checks this login with the selected provider before declaring setup complete. No model request is sent.</p>
          <button type="button" className="btn primary" disabled={busy || !activeCredential} onClick={() => void verifyActiveCredential()}>{busy ? "Checking…" : "Test connection again"}</button>
        </section>
      )}
      {step === "ready" && (
        <section className="settings-section">
          <h3>Opening your first session</h3>
          <p className="muted" role="status">GitHub and {providerOptions.find((provider) => provider.id === providerId)?.name || "your provider"} are ready. Selecting Bivy Cloud…</p>
          {githubError && <button type="button" className="btn" onClick={() => setGithubError(null)}>Try again</button>}
        </section>
      )}
      {step !== "ready" && <button type="button" className="btn ghost" onClick={onDone}>Finish setup later</button>}
    </div>
  );
}
