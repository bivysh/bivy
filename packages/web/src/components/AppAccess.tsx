// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { SessionAppsResult, ShareAppViewResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { writeClipboard } from "../clipboard.js";
import { Sheet } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { MoreMenu } from "./MoreMenu.js";
import { CheckIcon, LinkIcon } from "./UiIcons.js";

/** Opening Share grants nothing; copying a share link explicitly grants access. */
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
    let url = address;
    if (!url) {
      const result = await controller.appCommand("apps.list", sessionId, {}, nodeId) as unknown as SessionAppsResult;
      const view = result.apps.find((app) => app.id === appId)?.views.find((view) => view.id === viewId);
      url = view?.kind === "web" ? view.address : undefined;
    }
    if (!url) throw new Error("Address unavailable. Try republishing the app.");
    await copy(url, true);
  });
  return <>
    <button className="btn sm ghost" disabled={disabled} onClick={() => setOpen(true)} aria-label={`Share ${name}`}><LinkIcon size={15} />Share</button>
    {open && <Sheet title={`Share ${name}`} onClose={() => { if (!busy) { setOpen(false); setCopied(false); setNotice(""); setError(""); setManual(""); } }} autoFocusSearch={false}
      headExtra={<MoreMenu label="Sharing options" items={[
        { label: "Copy personal address", disabled: busy || (!address && !online), onSelect: () => void copyAddress() },
        { label: "Revoke access…", danger: true, separated: true, disabled: busy || !online || disabled, onSelect: () => setConfirm(true) },
      ]} />}>
      <div className="apps-sheet">
        <p className="apps-foot">Anyone with the link can open this app for 24 hours.</p>
        <button className="btn primary" disabled={busy || !online || disabled} aria-label="Copy share link" onClick={() => void run(async () => {
          const result = await controller.appCommand("apps.share", sessionId, { appId, viewId }, nodeId) as unknown as ShareAppViewResult;
          await copy(result.url);
        })}>{copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}<span role="status">{busy ? "Preparing…" : copied ? "Copied" : "Copy link"}</span></button>
        {error && <p className="apps-foot" role="alert">{error}</p>}
        {notice && <p className="apps-foot" role="status">{notice}</p>}
        {manual && <input className="field" readOnly value={manual} aria-label={`Link to ${name}`} onFocus={(e) => e.currentTarget.select()} />}
      </div>
      {confirm && <ConfirmDialog title="Revoke access?" message="Shared links and open previews will stop working. The app stays available." confirmLabel="Revoke access" danger onCancel={() => setConfirm(false)} onConfirm={() => {
        setConfirm(false);
        void run(async () => {
          await controller.appCommand("apps.revoke", sessionId, { appId, viewId }, nodeId);
          setNotice("Access revoked.");
          onRevoked?.();
        });
      }} />}
    </Sheet>}
  </>;
}
