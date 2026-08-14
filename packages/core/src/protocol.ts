// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The Bivy client<->node protocol, typed.
//
// Two layers, exactly as the legacy remote-app.js implements them:
//   * Commands  — outgoing, discriminated by `kind`. In direct mode most map
//                 to REST endpoints (ping/terminal ride WS); in relay mode they
//                 are sealed into frames.
//   * Events    — incoming, discriminated by `type`. Produced by the node
//                 (streamed over WS in direct mode, or decrypted from relay
//                 frames) and fed to the store reducer.
//
// The unions are intentionally open (`[k: string]: unknown`) so a newer node
// can add fields without breaking an older client — the legacy code relied on
// this and the reducer ignores unknown members.

export interface CommandBase {
  kind: string;
  requestId?: string;
  [k: string]: unknown;
}

export interface Command extends CommandBase {
  kind:
    | "ping"
    | "history"
    | "sessions.list"
    | "session.open"
    | "session.new"
    | "session.discover"
    | "session.import"
    | "session.delete"
    | "session.rename"
    | "session.pr.refresh"
    | "sessions.pr.refresh_all"
    | "prompt"
    | "abort"
    | "session.turn_attention.resolve"
    | "session.command.invoke"
    | "session.pause"
    | "session.resume"
    | "session.rewind"
    | "session.checkpoints"
    | "session.question.answer"
    | "models.list"
    // Warm the per-runtime model-query scratch for the given `runtimeIds` so the
    // first agent switch to any of them lists models instantly. Fire-and-forget
    // (no reply); sent when the agent picker opens.
    | "models.prefetch"
    | "model.select"
    | "thinking.set_level"
    | "runtimes.list"
    | "runtime.select"
    | "runtime.install"
    | "providers.list"
    | "provider.auth.get"
    | "provider.apiKey"
    | "provider.remove"
    | "provider.oauth.reset"
    | "provider.oauth.start"
    | "provider.oauth.code"
    // Multi-credential (labeled) management. `credentials.list` replies with
    // `credentials.records` ({ records: CredentialRecordSummary[] }). set/remove/
    // sync.set mutate one `provider:label` slot and ack via requestId.
    | "credentials.list"
    | "credentials.account.export"
    | "credential.set"
    | "credential.remove"
    | "credential.sync.set"
    // Selection presets (which labeled credential a project uses).
    // `credentials.presets.get` replies with `credentials.presets`.
    | "credentials.presets.get"
    | "credentials.presets.setActive"
    | "credentials.presets.setMapping"
    | "models.custom.list"
    | "models.custom.presets"
    | "models.custom.discover"
    | "models.custom.verify"
    | "models.custom.save"
    | "models.custom.remove"
    | "rulesets.list"
    | "rulesets.save"
    | "rulesets.remove"
    | "repos.list"
    | "branches.list"
    | "workspaces.list"
    | "node.settings.get"
    | "node.settings.set"
    // Kick off `bivy update` on the node from the version-mismatch banner.
    // Reply: `node.update.result` ({ ok, error? }).
    | "node.update"
    | "github.app.manifest.start"
    | "github.app.manifest.code"
    | "github.app.connect-existing"
    | "github.app.disconnect"
    // Repo-picker "Connect GitHub" device flow. start begins it; poll advances
    // it. Both reply with `github.connect.status`.
    | "github.connect.start"
    | "github.connect.poll"
    | "approval"
    | "stt.config.get"
    | "stt.config.set"
    | "transcribe"
    | "synthesize"
    | "terminal.list"
    | "terminal.multiplexers"
    | "terminal.takeover"
    | "terminal.open.tui"
    | "terminal.close.tui"
    | "node.stats"
    // Fetch a stored attachment's bytes by content hash (see AttachmentStore).
    // Reply: `attachment.data` (base64) or `attachment.error`.
    | "attachment.fetch"
    | (string & {});
}

export interface ServerEvent {
  type: string;
  requestId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

/**
 * One labeled credential as the Models screen sees it (non-secret). Mirrors the
 * node's `CredentialRecordSummary`; carried in the `credentials.records` event.
 */
export interface CredentialRecordSummary {
  provider: string;
  label: string;
  kind: "api_key" | "oauth" | "reference";
  /** Whether it syncs across the account's nodes, or stays on this one. */
  sync: "account" | "node";
  /** Where it came from — a Bivy login, or captured from an agent's own CLI. */
  origin: "bivy" | "agent-native";
  /** Epoch ms the OAuth access token expires, when `kind === "oauth"`. */
  expiresAt?: number;
  /** The non-secret pointer, when `kind === "reference"`. */
  ref?: string;
  /** Whether "Test connection" supports this provider/kind. */
  testable: boolean;
  /** The most recent "Test connection" result for this record, if any run. */
  lastVerifiedAt?: number;
  lastVerifiedOk?: boolean;
}

/**
 * Selection presets as the Models screen sees them. `active` is the preset
 * selection resolves against; `presets` maps a preset name to `provider → label`.
 * Carried in the `credentials.presets` event.
 */
export interface CredentialPresetsView {
  active?: string;
  presets?: Record<string, Record<string, string>>;
}

/**
 * A composer attachment. Matches the node's `attachmentsFrom` shape exactly:
 * images carry base64 `data` (passed to the model as vision); files carry
 * either base64 `data` (any type, binary included) or, for text files,
 * extracted `text` (possibly truncated). The node materializes file
 * attachments into the session working directory so the agent can open them
 * with its file tools. `omitted` marks a file the browser could not read.
 */
export interface PromptAttachment {
  kind: "image" | "file";
  name: string;
  size: number;
  mimeType: string;
  /** base64 (no data-URL prefix): the image bytes, or a file's raw bytes. */
  data?: string;
  /** extracted text for text files (an alternative to `data`). */
  text?: string;
  truncated?: boolean;
  omitted?: boolean;
  /**
   * SHA-256 content hash of a durably-stored attachment (see AttachmentStore on
   * the node). Present on attachments rehydrated from history: the bytes are no
   * longer inline (`data`/`text` are absent), so the client fetches them by hash
   * via `controller.fetchAttachment(hash)` to render a thumbnail/chip. This is
   * what makes attachments re-findable after a reload or on another device.
   */
  hash?: string;
}

/**
 * A durable reference to an attachment stored on the node, carried in a
 * `session.history` event as `[messageText, AttachmentRef[]]` pairs so a client
 * that never sent the attachment (a reload, or a different device) can still
 * render it by hash. Mirrors the node's AttachmentRef in src/session/attachment-store.ts.
 *
 * Also the ref type for a resolved *inline* markdown image (`![alt](https://…)`,
 * see InlineImageEvent below) — `session.history` carries those as
 * `[url, AttachmentRef]` pairs on `inlineImageRefs`, one ref per URL rather than
 * an array (a URL only ever resolves to one image).
 */
export interface AttachmentRef {
  hash: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

/**
 * The inner event of a `session.event` the node emits when an AGENT sends an
 * attachment into the chat (image or file) — the reverse of the composer
 * paperclip. Carried live so the client can render a chip/thumbnail immediately
 * (via `controller.fetchAttachment(ref.hash)`); durable history reproduces the
 * same entry from an outbound-attachment overlay folded into the transcript, so
 * a reload or another device shows it too. `id` is a stable transcript-entry id
 * so the live entry and its history twin don't double up.
 */
export interface AttachmentEvent {
  type: "attachment";
  id: string;
  ref: AttachmentRef;
  caption?: string;
}

/**
 * The inner event of a `session.event` the node emits when it finishes fetching
 * a remote image an agent referenced with markdown syntax (`![alt](https://…)`,
 * see #293 / src/session/inline-image-fetch.ts). Carried live so an
 * already-open chat can hydrate the placeholder `<img data-remote-src>`
 * markdown.ts renders into a `blob:` URL immediately (via
 * `controller.fetchAttachment(ref.hash)`), without waiting for a reload; durable
 * history reproduces the same url→ref mapping via `inlineImageRefs` on
 * `session.history`, so a reload resolves it from the log instead of re-fetching.
 * `url` is the exact `https://` string the markdown referenced — the client
 * matches it back onto the `data-remote-src` attribute(s) that need it.
 */
export interface InlineImageEvent {
  type: "inlineImage";
  url: string;
  ref: AttachmentRef;
}

/**
 * How a prompt sent to an already-busy (streaming) session should be handled by
 * the runtime: `"steer"` injects it into the current turn immediately (an
 * explicit interrupt); `"followUp"` defers it until the current turn ends. Not
 * every runtime honors both — see RuntimeCapabilities.streamingBehaviors on the
 * node — so the client only ever sends `"steer"` explicitly (see
 * AppController.steerNow/sendFollowupNow) and otherwise holds a busy session's
 * prompts in its own visible queue (AppState.followupsBySession) rather than
 * relying on a runtime-specific "followUp" to queue them invisibly.
 */
export type StreamingBehavior = "steer" | "followUp";

/** Connection lifecycle surfaced by a Transport, independent of the node's own events. */
export type ConnectionStatus =
  | "offline"
  | "connecting"
  | "linking"
  | "pairing"
  | "online"
  | "reconnecting";

export interface TransportHandlers {
  /** A decoded node event ready for the reducer. */
  onEvent(event: ServerEvent): void;
  /** Connection state changed (drives the status pill). */
  onStatus(status: ConnectionStatus): void;
  /** A transport-level error string, for surfacing non-fatally. */
  onError?(message: string): void;
}

export interface Transport {
  /** Open the connection and start streaming events. Idempotent-ish: safe to call to (re)connect. */
  connect(): Promise<void>;
  /** Send a command to the node. Queues while offline where the transport supports it. */
  send(command: Command): void | Promise<void>;
  /** Tear down the connection. */
  close(): void;
  /**
   * Drop the current socket and dial a fresh one, without the "offline" detour
   * that close()+connect() takes. Used to recover from a zombie socket — one
   * iOS resumed after suspension without ever firing `onclose`, so the client
   * still thinks it's online while sends vanish into a dead pipe.
   */
  reconnect(): void;
}
