// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import { Badge } from "./Badge.js";
import type { ArtifactEntry, PromptAttachment } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { relTime } from "./ChangesCard.js";
import { controller } from "../store/useStore.js";
import { ImageGallery } from "./ImageGallery.js";

// Session/Run artifacts: everything deriveArtifacts(state.activeSession.transcript) found —
// agent-sent attachments, user uploads, resolved inline images — grouped so a
// user can find "the report the agent made" without hunting through the
// transcript. Bytes are fetched on demand through the same authenticated
// node/E2E path chat attachments already use (controller.fetchAttachment); a
// null result (offline node, pruned blob) is shown honestly rather than
// silently retried or hidden.

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function base64ToBlobUrl(base64: string, mimeType: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  } catch {
    return null;
  }
}

function toAttachment(artifact: ArtifactEntry): PromptAttachment {
  return {
    kind: artifact.kind,
    name: artifact.name,
    size: artifact.size,
    mimeType: artifact.mimeType,
    hash: artifact.hash,
    createdAt: artifact.createdAt,
    artifact: artifact.artifact,
  };
}

type StoredFile = Pick<ArtifactEntry, "hash" | "name" | "mimeType" | "createdAt">;

/** Lazily resolves a stored file to an object URL through the same
 * authenticated attachment path as chat, while retaining an honest
 * unavailable state. */
export function useAttachmentUrl(file: StoredFile): { status: "loading" | "ready" | "unavailable"; url?: string } {
  const [state, setState] = useState<{ status: "loading" | "ready" | "unavailable"; url?: string }>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void controller.fetchAttachment(file.hash, file.createdAt).then((res) => {
      if (cancelled) return;
      const url = res && base64ToBlobUrl(res.data, res.mimeType || file.mimeType);
      if (url) { objectUrl = url; setState({ status: "ready", url }); } else setState({ status: "unavailable" });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.hash, file.mimeType, file.createdAt]);
  return state;
}

/** Save a stored file; false when the machine can't serve it right now. */
export async function downloadAttachment(file: StoredFile): Promise<boolean> {
  const res = await controller.fetchAttachment(file.hash, Number.MAX_SAFE_INTEGER);
  const url = res && base64ToBlobUrl(res.data, res.mimeType || file.mimeType);
  if (!url) return false;
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

function ArtifactThumb({ artifact, onOpen }: { artifact: ArtifactEntry; onOpen: () => void }) {
  const state = useAttachmentUrl(artifact);

  if (state.status === "ready") {
    return (
      <button type="button" className="artifact-thumb-button" onClick={onOpen} aria-label={`View ${artifact.name}`}>
        <img className="artifact-thumb" src={state.url} alt="" />
      </button>
    );
  }
  return (
    <span className={`artifact-thumb artifact-thumb-${state.status}`} aria-hidden>
      {state.status === "unavailable" ? "⚠" : ""}
    </span>
  );
}

function ArtifactRow({ artifact, onJump, onOpenImage }: { artifact: ArtifactEntry; onJump: (entryId: string) => void; onOpenImage?: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const download = async () => {
    setDownloading(true);
    setUnavailable(false);
    const ok = await downloadAttachment(artifact);
    setDownloading(false);
    if (!ok) setUnavailable(true);
  };

  const meta = [
    fmtBytes(artifact.size),
    artifact.createdAt ? relTime(artifact.createdAt) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="artifact-row">
      {artifact.kind === "image" && onOpenImage ? <ArtifactThumb artifact={artifact} onOpen={onOpenImage} /> : <span className="artifact-thumb artifact-glyph" aria-hidden>📄</span>}
      <div className="artifact-main">
        <div className="artifact-name-line">
          <span className="artifact-name" title={artifact.name}>{artifact.name}</span>
          {artifact.artifact && <Badge tone="accent" variant="solid" upper>Artifact</Badge>}
        </div>
        <div className="artifact-meta">{meta}</div>
        {artifact.caption && <div className="artifact-caption">{artifact.caption.split(/\r?\n/, 1)[0]}</div>}
        {unavailable && (
          <div className="artifact-unavailable">Not available right now — the Machine may be offline, or this file was pruned.</div>
        )}
      </div>
      <div className="artifact-actions">
        <button type="button" className="btn sm" onClick={() => void download()} disabled={downloading} aria-busy={downloading}>
          {downloading ? "Downloading…" : "Download"}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => onJump(artifact.entryId)}>
          Jump to turn
        </button>
      </div>
    </div>
  );
}

export function ArtifactsSheet({ artifacts, onClose }: { artifacts: ArtifactEntry[]; onClose: () => void }) {
  const images = useMemo(() => artifacts.filter((a) => a.kind === "image"), [artifacts]);
  const imageAttachments = useMemo(() => images.map(toAttachment), [images]);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

  // Best-effort: only scrolls to the turn if it's currently mounted in the
  // (windowed) transcript — an artifact from far enough back that "Load
  // earlier" hasn't been clicked yet simply doesn't jump. Still closes the
  // sheet either way, so the action never looks like it silently failed.
  const jumpToTurn = (entryId: string) => {
    onClose();
    requestAnimationFrame(() => {
      document.getElementById(`msg-${entryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const files = artifacts.filter((a) => a.kind === "file");
  const title = artifacts.length > 0 ? `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}` : "Artifacts";

  return (
    <Sheet title={title} onClose={onClose} autoFocusSearch={false}>
      {artifacts.length === 0 && <div className="changes-binary">No artifacts yet this session.</div>}
      {images.length > 0 && (
        <div className="artifacts-group">
          <div className="artifacts-group-title">Images</div>
          {images.map((a, index) => <ArtifactRow key={a.id} artifact={a} onJump={jumpToTurn} onOpenImage={() => setGalleryIndex(index)} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className="artifacts-group">
          <div className="artifacts-group-title">Files</div>
          {files.map((a) => <ArtifactRow key={a.id} artifact={a} onJump={jumpToTurn} />)}
        </div>
      )}
      {galleryIndex != null && (
        <ImageGallery images={imageAttachments} index={galleryIndex} onClose={() => setGalleryIndex(null)} />
      )}
    </Sheet>
  );
}
