// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AppState, NativeCredentialAgent, NativeCredentialPreview, NativeCredentialImportResult } from "@bivy/core";
import { controller } from "../store/useStore.js";

const agentNames = { claude: "Claude", codex: "Codex", grok: "Grok" };
const previewStatus = {
  ready: "Ready to import", conflict: "Already saved — use another name to keep both",
  missing: "No credential file found", unreadable: "Credential file could not be read",
  unsupported: "Login format not supported",
};
const resultStatus = { imported: "Imported", conflict: "Skipped — credential already exists", changed: "Login changed — scan again" };

export function NativeCredentialImport({ state, onBack }: { state: AppState; onBack(): void }) {
  const { currentNodeId, nodes, status } = state.connection;
  const [label, setLabel] = useState("");
  const [sync, setSync] = useState<"node" | "account">("node");
  const [preview, setPreview] = useState<NativeCredentialPreview | null>(null);
  const [selected, setSelected] = useState<NativeCredentialAgent[]>([]);
  const [result, setResult] = useState<NativeCredentialImportResult | null>(null);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reset = () => { generation.current++; setPreview(null); setSelected([]); setResult(null); setError(null); setBusy(null); };
  useEffect(() => { reset(); return () => { generation.current += 1; }; }, [currentNodeId, status]);
  const machineName = nodes.find((node) => node.id === currentNodeId)?.name || currentNodeId || "Connected machine";
  const scan = async () => {
    const attempt = ++generation.current;
    setBusy("scan"); setError(null); setResult(null); setPreview(null);
    try {
      const found = await controller.previewNativeCredentials(currentNodeId, label);
      if (generation.current !== attempt) return;
      setPreview(found); setSelected(found.items.filter((item) => item.status === "ready").map((item) => item.agent));
    } catch (e) { if (generation.current === attempt) setError(e instanceof Error ? e.message : "Scan failed."); }
    finally { if (generation.current === attempt) setBusy(null); }
  };
  const confirm = async () => {
    if (!preview) return;
    const attempt = ++generation.current;
    setBusy("import"); setError(null);
    try {
      const imported = await controller.importNativeCredentials(currentNodeId, preview.previewId, selected, sync);
      if (generation.current !== attempt) return;
      setResult(imported); setPreview(null); setSelected([]);
      controller.listCredentialRecords(); controller.listProviders();
    } catch (e) {
      if (generation.current === attempt) { setError(e instanceof Error ? e.message : "Import failed. Scan again before retrying."); setPreview(null); }
    } finally { if (generation.current === attempt) setBusy(null); }
  };
  return <div className="settings-form credential-vault">
    <button autoFocus={controller.direct || !nodes.length} className="btn link" disabled={busy === "import"} onClick={onBack}>‹ Credentials</button>
    <h3>Import from machine</h3>
    <p className="muted">Bring existing Claude, Codex, or Grok sign-ins into Bivy. Saved credentials are never replaced.</p>
    <label className="field-label" htmlFor="native-import-machine">Source machine</label>
    <select autoFocus={!controller.direct && nodes.length > 0} id="native-import-machine" className="picker-search" value={currentNodeId ?? ""} disabled={controller.direct || Boolean(busy) || !nodes.length} onChange={(e) => { reset(); controller.switchNode(e.target.value); }}>
      {!nodes.some((node) => node.id === currentNodeId) && <option value={currentNodeId ?? ""}>{status === "online" ? machineName : "Choose an online machine"}</option>}
      {nodes.filter((node) => !controller.direct || node.id === currentNodeId).map((node) => <option key={node.id} value={node.id} disabled={!node.online && node.id !== currentNodeId}>{node.name || node.id}{!node.online ? " — offline" : ""}</option>)}
    </select>
    <p className="muted small">{controller.direct ? "Direct connection: imports run on this machine only." : "Selecting a machine also connects Settings to it."} Only logins readable by the Bivy daemon’s OS user can be found.</p>
    {status !== "online" && <p className="banner inline" role="status">{status === "connecting" ? "Connecting to machine…" : "Connect an online machine to scan its logins."}</p>}
    <details className="vault-advanced"><summary>Keep a second login</summary>
      <label className="field-label" htmlFor="native-import-label">Credential name (optional)</label>
      <input id="native-import-label" className="picker-search" maxLength={100} placeholder="Default — or Work to keep a second login" disabled={Boolean(busy)} value={label} onChange={(e) => { setLabel(e.target.value); reset(); }} />
    </details>
    <button className="btn" disabled={status !== "online" || Boolean(busy)} onClick={() => void scan()}>{busy === "scan" ? "Scanning…" : preview || result ? "Scan again" : "Scan for logins"}</button>
    {busy && <p className="muted" role="status">{busy === "scan" ? "Reading login files on the selected machine…" : "Importing selected logins…"}</p>}
    {preview && <>
      <h4 className="settings-subhead">Logins on {machineName}</h4>
      <div className="picker-list">
        {preview.items.map((item) => <label className="picker-item" key={item.agent}>
          <span><strong>{agentNames[item.agent]}</strong><small>{item.provider ? `${item.provider} · ${item.kind === "oauth" ? "Subscription sign-in" : "API key"} · ` : ""}{previewStatus[item.status]}</small></span>
          <input type="checkbox" aria-label={`Import ${agentNames[item.agent]}`} disabled={item.status !== "ready" || Boolean(busy)} checked={selected.includes(item.agent)} onChange={(e) => setSelected((previous) => e.target.checked ? [...previous, item.agent] : previous.filter((agent) => agent !== item.agent))} />
        </label>)}
      </div>
      {!preview.items.some((item) => item.status === "ready") && <p role="status" className="muted">No new logins to import. Sign in on this machine, or use another credential name if already saved.</p>}
      <label className="field-label" htmlFor="native-import-scope">Available on</label>
      <select id="native-import-scope" className="picker-search" value={sync} disabled={Boolean(busy)} onChange={(e) => setSync(e.target.value as "node" | "account")}>
        <option value="node">Only the source machine</option>
        <option value="account">All my machines — end-to-end encrypted</option>
      </select>
      <p className="muted">{sync === "account" ? "Importing grants account sync, not unattended cloud access. Other machines receive credentials when connected." : "Imported logins stay in this machine’s encrypted vault. You can enable account sync later."}</p>
      <button className="btn primary block" disabled={!selected.length || Boolean(busy) || status !== "online"} onClick={() => void confirm()}>{busy === "import" ? "Importing…" : `Import ${selected.length || "selected"} login${selected.length === 1 ? "" : "s"}`}</button>
    </>}
    {result && <div className="banner inline" role="status">
      {result.items.map((item) => <p key={item.agent}>{agentNames[item.agent]}: {resultStatus[item.status]}</p>)}
      {result.warning && <p>{result.warning}</p>}
      {result.items.some((item) => item.status === "imported") && <p>{sync === "account" ? "Saved and eligible for account sync; delivery to other machines is not yet confirmed." : `Saved only on ${machineName}.`}{label.trim() && " Select the named credential in model accounts to use it."}</p>}
    </div>}
    {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
    <details className="vault-advanced"><summary>What can be imported?</summary>
      <p className="muted">File-based logins only; OS-keychain-only logins are not supported. Tokens never appear in this preview. Native logins are left untouched.</p>
      <p className="muted">Access is not verified. Subscription sign-ins work only with compatible Bivy-managed runtimes. Concurrent OAuth refresh by native CLIs or other machines may require signing in again.</p>
    </details>
  </div>;
}
