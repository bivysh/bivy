// SPDX-License-Identifier: FSL-1.1-ALv2
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
    | "session.delete"
    | "session.rename"
    | "session.pr.refresh"
    | "sessions.pr.refresh_all"
    | "prompt"
    | "abort"
    | "session.command.invoke"
    | "session.pause"
    | "session.resume"
    | "session.rewind"
    | "session.checkpoints"
    | "session.question.answer"
    | "models.list"
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
    | "models.custom.list"
    | "models.custom.presets"
    | "models.custom.save"
    | "models.custom.remove"
    | "repos.list"
    | "branches.list"
    | "workspaces.list"
    | "node.settings.get"
    | "node.settings.set"
    | "github.app.manifest.start"
    | "github.app.manifest.code"
    | "github.app.connect-existing"
    | "github.app.disconnect"
    | "approval"
    | "stt.config.get"
    | "stt.config.set"
    | "transcribe"
    | "terminal.list"
    | "terminal.multiplexers"
    | "terminal.takeover"
    | "node.stats"
    | (string & {});
}

export interface ServerEvent {
  type: string;
  requestId?: string;
  sessionId?: string;
  [k: string]: unknown;
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
}

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
