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
  const [managedAuthRunner, setManagedAuthRunner] = useState(() => sessionStorage.getItem("bivy:managed-auth-runner") === "1");
  const configuredProviders = useMemo(() => state.catalogs.providers.filter((provider) => provider.configured), [state.catalogs.providers]);
  const [providerId, setProviderId] = useState("anthropic");
  const availableAgents = useMemo(
    () => state.catalogs.runtimes.filter((runtime) => String((runtime as { status?: string }).status ?? "available") === "available"),
    [state.catalogs.runtimes],
  );
  const selectedAgentId = state.catalogs.selectedAgentId || availableAgents[0]?.id || "";
  const providerOptions = useMemo(() => state.catalogs.providers.length > 0
    ? state.catalogs.providers
    : [
        { id: "anthropic", name: "Anthropic / Claude" },
        { id: "openai-codex", name: "OpenAI / Codex" },
        { id: "openai", name: "OpenAI API" },
      ], [state.catalogs.providers]);
  const apiKeyProvider = modelAuthApiKeyProvider(providerId);
  const activeCredential = state.settings.credentialRecords.find(
    (record) => record.provider === providerId || record.provider === apiKeyProvider,
  );
  const selectedProviderConfigured = Boolean(
    state.catalogs.providers.find((provider) => provider.id === providerId)?.configured || activeCredential,
  );
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
      : managedAuthRunner && !activeCredential?.unattended ? "custody" : "ready";
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

  return (
    <div className="connect-runner">
      <div>
        <p className="connect-eyebrow">Welcome to Bivy</p>
        <h2 className="connect-title">Set up your first session</h2>
        <p className="connect-sub">Connect GitHub, choose where agents run, and authenticate a model provider.</p>
      </div>
      <ol className="readiness-checks" aria-label="Onboarding progress">
        <li className={`readiness-check ${hasGithub ? "state-passed" : "state-pending"}`}><span className={`readiness-mark ${hasGithub ? "mark-passed" : ""}`}>{hasGithub ? "✓" : "1"}</span><span><span className="readiness-label">GitHub App</span><span className="readiness-detail"> · repository access</span></span></li>
        <li className={`readiness-check ${hasMachine ? "state-passed" : "state-pending"}`}><span className={`readiness-mark ${hasMachine ? "mark-passed" : ""}`}>{hasMachine ? "✓" : "2"}</span><span><span className="readiness-label">Machine</span><span className="readiness-detail"> · personal or managed compute</span></span></li>
        <li className={`readiness-check ${configuredProviders.length ? "state-passed" : "state-pending"}`}><span className={`readiness-mark ${configuredProviders.length ? "mark-passed" : ""}`}>{configuredProviders.length ? "✓" : "3"}</span><span><span className="readiness-label">Model provider</span><span className="readiness-detail"> · agent authentication</span></span></li>
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
          <h3>Authenticate your agent</h3>
          <p className="muted">Credentials are sent to your connected machine and encrypted for account sync. Bivy does not store them as plaintext.</p>
          <label className="field-label" htmlFor="onboarding-agent">Agent</label>
          <select id="onboarding-agent" className="picker-search" value={selectedAgentId} onChange={(event) => {
            const runtime = availableAgents.find((candidate) => candidate.id === event.target.value);
            if (!runtime) return;
            controller.chooseAgent(runtime);
            if (runtime.id.includes("codex")) setProviderId("openai-codex");
            else if (runtime.id.includes("claude")) setProviderId("anthropic");
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
          <h3>Keep this login for managed sessions</h3>
          <p className="muted">The setup Machine is temporary. To let future managed Machines use this credential, Bivy creates a separate encrypted hosted-custody snapshot. This does not expose it to GitHub or other users, and you can revoke the grant in Providers & credentials.</p>
          <button type="button" className="btn primary" disabled={busy || !activeCredential} onClick={() => {
            if (!activeCredential) return;
            setBusy(true); setGithubError(null);
            controller.setCredentialUnattended(activeCredential.provider, activeCredential.label, true)
              .then(() => controller.listCredentialRecords())
              .catch((error) => setGithubError(String((error as Error)?.message || error)))
              .finally(() => setBusy(false));
          }}>{busy ? "Encrypting…" : "Enable managed credential reuse"}</button>
        </section>
      )}
      {step === "ready" && (
        <section className="settings-section">
          <h3>Ready for your first task</h3>
          <p className="muted">GitHub, {state.connection.nodes.find((node) => node.id === state.connection.currentNodeId)?.name || "your machine"}, and {configuredProviders[0]?.name || "your provider"} are connected.</p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => {
            setBusy(true); setGithubError(null);
            const target = managedAuthRunner
              ? controller.ensureManagedSessionDefaults()
              : controller.listEphemeralConfigs().then((configs) => configs.find((config) => config.computeSource === "managed") ?? null);
            target
              .then((config) => {
                if (config) controller.pickDraftEphemeralRunner(config);
                sessionStorage.removeItem("bivy:managed-auth-runner");
                onDone();
              })
              .catch((error) => setGithubError(String((error as Error)?.message || error)))
              .finally(() => setBusy(false));
          }}>{busy ? "Preparing…" : "Choose a repository and start"}</button>
        </section>
      )}
      {step !== "ready" && <button type="button" className="btn ghost" onClick={onDone}>Finish setup later</button>}
    </div>
  );
}
