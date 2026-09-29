// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { DEFAULT_SHARE_DURATION, SHARE_DURATIONS, type AppViewSharing, type SessionAppsResult, type ShareAppViewResult, type ShareDuration } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { writeClipboard } from "../clipboard.js";
import { Sheet } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { MoreMenu } from "./MoreMenu.js";
import { Toggle } from "./Toggle.js";
import { CheckIcon, LinkIcon } from "./UiIcons.js";

/** The last share options chosen on this device. */
const OPTIONS_KEY = "bivy.app-share";
type Options = { duration: ShareDuration; controls: boolean };
function savedOptions(): Options {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") as Partial<Options>;
    return { duration: SHARE_DURATIONS.some((row) => row.id === saved.duration) ? saved.duration! : DEFAULT_SHARE_DURATION, controls: saved.controls !== false };
  } catch { return { duration: DEFAULT_SHARE_DURATION, controls: true }; }
}
const until = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

/** Opening Share grants nothing; copying a share link explicitly grants access,
 * for the chosen time and with or without the feedback tools. */
export function AppAccess({ sessionId, appId, viewId, name, nodeId, address, disabled, onRevoked }: {
  sessionId: string; appId: string; viewId: string; name: string; nodeId?: string | null;
  address?: string; disabled?: boolean; onRevoked?: () => void;
}) {
  const { connection } = useAppState();
  const online = (Boolean(nodeId) && !controller.direct && nodeId !== connection.currentNodeId) || connection.status === "online";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [options, setOptions] = useState(savedOptions);
  const [sharing, setSharing] = useState<AppViewSharing | null>(null);
  const [stopping, setStopping] = useState(false);
  const choose = (next: Partial<Options>) => setOptions((current) => {
    const merged = { ...current, ...next };
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(merged)); } catch { /* private mode */ }
    return merged;
  });
  const findView = async () => {
    const result = await controller.appCommand("apps.list", sessionId, {}, nodeId) as unknown as SessionAppsResult;
    const view = result.apps.find((app) => app.id === appId)?.views.find((view) => view.id === viewId);
    return view?.kind === "web" ? view : undefined;
  };
  const refresh = () => findView().then((view) => setSharing(view?.sharing ?? null)).catch(() => {});
  useEffect(() => { if (open && online) void refresh(); }, [open, online]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setCopied(false); setError(""); setNotice(""); setManual("");
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update app access."); }
    finally { setBusy(false); }
  };
  const copy = async (url: string, personal = false) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin === location.origin) throw new Error("Machine returned an unsafe preview URL.");
    const written = await writeClipboard(parsed.href);
    if (personal) setNotice(written ? "Address copied. Only works when signed in to Bivy." : "Your address · Bivy sign-in required.");
    else if (written) setCopied(true);
    else setNotice("Copy this link to share.");
    if (!written) setManual(parsed.href);
  };
  const copyAddress = () => run(async () => {
    const url = address ?? (await findView())?.address;
    if (!url) throw new Error("Address unavailable. Try republishing the app.");
    await copy(url, true);
  });
  return <>
    <button className="btn sm ghost" disabled={disabled} onClick={() => setOpen(true)} aria-label={`Share ${name}`}><LinkIcon size={15} />Share</button>
    {open && <Sheet title={`Share ${name}`} onClose={() => { setOpen(false); setCopied(false); setNotice(""); setError(""); setManual(""); }} autoFocusSearch={false}
      headExtra={<MoreMenu label="Sharing options" items={[
        { label: "Copy personal address", disabled: busy || (!address && !online), onSelect: () => void copyAddress() },
        { label: "Revoke all access…", danger: true, separated: true, disabled: busy || !online || disabled, onSelect: () => setConfirm(true) },
      ]} />}>
      <div className="apps-sheet">
        {sharing && <div className="banner" data-tone="accent">
          <span className="banner-text" role="status">Shared · {sharing.links === 1 ? "1 link" : `${sharing.links} links`} until {until(sharing.expiresAt)}</span>
          <span className="banner-actions"><button className="btn sm danger-ghost" disabled={busy || !online} onClick={() => setStopping(true)}>Stop sharing</button></span>
        </div>}
        <div className="apps-group">
          <p className="apps-group-title" id={`share-for-${viewId}`}>Link works for</p>
          <div className="segmented" role="radiogroup" aria-labelledby={`share-for-${viewId}`}>
            {SHARE_DURATIONS.map((row) => <button key={row.id} type="button" role="radio" className="seg-btn" aria-checked={options.duration === row.id} onClick={() => choose({ duration: row.id })}>{row.label}</button>)}
          </div>
        </div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-text">
            <span className="settings-toggle-title">Feedback tools</span>
            <span className="muted small">{options.controls ? "People can point, draw and leave you notes." : "People see only the app."}</span>
          </div>
          <Toggle checked={options.controls} onChange={(controls) => choose({ controls })} label="Feedback tools" />
        </div>
        <p className="apps-foot">Anyone with the link can use this app, including its live backend, until it expires or you stop sharing.</p>
        <button className="btn primary" disabled={busy || !online || disabled} aria-label="Copy share link" onClick={() => void run(async () => {
          const result = await controller.appCommand("apps.share", sessionId, { appId, viewId, duration: options.duration, controls: options.controls }, nodeId) as unknown as ShareAppViewResult;
          await copy(result.url);
          void refresh();
        })}>{copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}<span role="status">{busy ? "Preparing…" : copied ? "Copied" : "Copy link"}</span></button>
        {error && <p className="apps-foot" role="alert">{error}</p>}
        {notice && <p className="apps-foot" role="status">{notice}</p>}
        {manual && <input className="field" readOnly value={manual} aria-label={`Link to ${name}`} onFocus={(e) => e.currentTarget.select()} />}
      </div>
      {stopping && <ConfirmDialog title="Stop sharing?" message="Every share link stops working, and people who have the app open lose it. Your own previews keep working." confirmLabel="Stop sharing" danger onCancel={() => setStopping(false)} onConfirm={() => {
        setStopping(false);
        void run(async () => {
          await controller.appCommand("apps.unshare", sessionId, { appId, viewId }, nodeId);
          setSharing(null);
          setNotice("Sharing stopped.");
        });
      }} />}
      {confirm && <ConfirmDialog title="Revoke all access?" message="Share links and every open preview, including yours, stop working. The app stays available." confirmLabel="Revoke access" danger onCancel={() => setConfirm(false)} onConfirm={() => {
        setConfirm(false);
        void run(async () => {
          await controller.appCommand("apps.revoke", sessionId, { appId, viewId }, nodeId);
          setSharing(null);
          setNotice("Access revoked.");
          onRevoked?.();
        });
      }} />}
    </Sheet>}
  </>;
}
