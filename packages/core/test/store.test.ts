// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it, vi } from "vitest";
import { SessionStore, githubIssueRefFromSource, isGithubQueueSource, repoFromSource, stripAttachmentPlaceholders, toHtml } from "../src/index.js";

describe("isGithubQueueSource", () => {
  it("flags issue-backed and generic queue sources", () => {
    expect(isGithubQueueSource("issue:owner/repo#123")).toBe(true);
    expect(isGithubQueueSource("queue:slack")).toBe(true);
    expect(isGithubQueueSource("queue:github:issue")).toBe(true);
  });

  it("does not flag manually-opened sessions", () => {
    expect(isGithubQueueSource("repo:owner/repo")).toBe(false);
    expect(isGithubQueueSource("manual")).toBe(false);
    expect(isGithubQueueSource(undefined)).toBe(false);
    expect(isGithubQueueSource(42)).toBe(false);
  });
});

describe("githubIssueRefFromSource", () => {
  it("parses the repo slug and issue number", () => {
    expect(githubIssueRefFromSource("issue:bivysh/bivy#388")).toEqual({ repo: "bivysh/bivy", issueNumber: 388 });
  });

  it("returns null for sources with no single issue to link to", () => {
    expect(githubIssueRefFromSource("queue:slack")).toBeNull();
    expect(githubIssueRefFromSource("repo:owner/repo")).toBeNull();
    expect(githubIssueRefFromSource("issue:no-hash-here")).toBeNull();
    expect(githubIssueRefFromSource(undefined)).toBeNull();
  });
});

describe("repoFromSource (regression: stays disjoint from the queue prefixes)", () => {
  it("only matches repo: sources, not issue:/queue: ones", () => {
    expect(repoFromSource("repo:owner/repo")).toBe("owner/repo");
    expect(repoFromSource("issue:owner/repo#1")).toBeNull();
    expect(repoFromSource("queue:slack")).toBeNull();
  });
});

describe("stripAttachmentPlaceholders", () => {
  it("removes the appended image placeholder but keeps the caption", () => {
    const composed = "check this out\n\n[Image attachment: shot.png (12345 bytes)]";
    expect(stripAttachmentPlaceholders(composed)).toBe("check this out");
  });

  it("removes multiple placeholder lines", () => {
    const composed =
      "how are follow ups handled?\n\n[Image attachment: IMG_0581.png (353770 bytes)]\n\n[Image attachment: IMG_0580.png (222480 bytes)]";
    expect(stripAttachmentPlaceholders(composed)).toBe("how are follow ups handled?");
  });

  it("reduces an attachment-only message to empty text", () => {
    expect(stripAttachmentPlaceholders("[Image attachment: shot.png (12345 bytes)]")).toBe("");
  });

  it("removes the binary file placeholder and the fenced text-file section", () => {
    const bin = "see this\n\n[File attachment: data.bin (10 bytes, application/octet-stream); content not included because it is binary or unreadable]";
    expect(stripAttachmentPlaceholders(bin)).toBe("see this");
    const textFile = "read this\n\n--- File attachment: notes.txt (5 bytes, text/plain) ---\nhello\n--- end notes.txt ---";
    expect(stripAttachmentPlaceholders(textFile)).toBe("read this");
  });

  it("removes the materialized-file placeholder note (saved to a path)", () => {
    const saved =
      "look at this\n\n[File attachment: key.pem (1675 bytes, application/x-x509-ca-cert) saved to .bivy-attachments/key.pem - read it with your file tools]";
    expect(stripAttachmentPlaceholders(saved)).toBe("look at this");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripAttachmentPlaceholders("just a message")).toBe("just a message");
    expect(stripAttachmentPlaceholders("")).toBe("");
  });
});

describe("SessionStore", () => {
  it("retains authoritative activation readiness probes", () => {
    const store = new SessionStore();
    store.apply({ type: "activation.readiness", credential: { configured: true, probed: true, ok: true }, repository: { chosen: false, probed: true, ok: false, authed: true } } as never);
    expect(store.getState().activationReadiness).toEqual({ credential: { configured: true, probed: true, ok: true }, repository: { chosen: false, probed: true, ok: false, authed: true } });
  });

  it("stores a valid Machine capability inventory snapshot", () => {
    const store = new SessionStore();
    const capabilities = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      os: { platform: "linux", arch: "x64", release: "6.1.0", type: "Linux" },
      agents: { maintained: [{ id: "pi", label: "Pi", kind: "maintained", installed: true }], custom: [] },
      providers: { configured: ["anthropic"], localEndpoints: { count: 0, withModels: 0 } },
      docker: { state: "unknown" },
      gpu: { state: "unknown" },
      plugins: [],
      workspaces: { count: 1 },
    };
    store.apply({ type: "capabilities", capabilities } as never);
    expect(store.getState().capabilities).toEqual(capabilities);
  });

  it("ignores a garbled capabilities frame instead of blanking a good panel", () => {
    const store = new SessionStore();
    const capabilities = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      os: { platform: "linux", arch: "x64", release: "6.1.0", type: "Linux" },
      agents: { maintained: [], custom: [] },
      providers: { configured: [], localEndpoints: { count: 0, withModels: 0 } },
      docker: { state: "unknown" },
      gpu: { state: "unknown" },
      plugins: [],
      workspaces: { count: 0 },
    };
    store.apply({ type: "capabilities", capabilities } as never);
    // A later, malformed frame (missing `os`) must not clobber the good snapshot.
    store.apply({ type: "capabilities", capabilities: { generatedAt: "2026-01-01T00:00:01.000Z" } } as never);
    expect(store.getState().capabilities).toEqual(capabilities);
  });

  it("retains a credential's testable/verification fields, feeding the redacted readiness projection", () => {
    const store = new SessionStore();
    store.apply({
      type: "credentials.records",
      records: [
        { provider: "anthropic", label: "default", kind: "api_key", sync: "node", origin: "bivy", testable: true, lastVerifiedAt: 1700000000000, lastVerifiedOk: true },
      ],
    } as never);
    expect(store.getState().credentialRecords).toEqual([
      { provider: "anthropic", label: "default", kind: "api_key", sync: "node", origin: "bivy", testable: true, lastVerifiedAt: 1700000000000, lastVerifiedOk: true },
    ]);
  });

  it("retains node audit degradation in Session context", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", auditHealth: { storage: "corrupt", writes: "degraded", failedWrites: 2, corruptLines: 1 }, eventLogHealth: { state: "degraded", operation: "append", at: 42 } }] } as never);
    expect(store.getState().sessions[0].auditHealth).toEqual({ storage: "corrupt", writes: "degraded", failedWrites: 2, corruptLines: 1 });
    expect(store.getState().sessions[0].eventLogHealth).toEqual({ state: "degraded", operation: "append", at: 42 });
  });

  it("retains observed Session protection context from the node", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", sandbox: "workspace-write", approvalMode: "risky", ephemeral: true, executionProfile: "isolated_customer_cloud" }] } as never);
    expect(store.getState().sessions[0]).toMatchObject({ sandbox: "workspace-write", approvalMode: "risky", ephemeral: true, executionProfile: "isolated_customer_cloud" });
  });

  it("notifies subscribers and exposes immutable snapshots", () => {
    const store = new SessionStore();
    const seen: number = 0;
    const fn = vi.fn();
    store.subscribe(fn);
    const before = store.getState();
    store.setStatus("online");
    expect(store.getState()).not.toBe(before); // new identity => React re-renders
    expect(store.getState().status).toBe("online");
    expect(fn).toHaveBeenCalled();
    void seen;
  });

  it("tracks the reactive signed-in flag for the auth gate", () => {
    const store = new SessionStore();
    expect(store.getState().signedIn).toBe(false);
    const before = store.getState();
    store.setSignedIn(true);
    // New identity so the auth gate re-renders the moment a sign-in completes.
    expect(store.getState()).not.toBe(before);
    expect(store.getState().signedIn).toBe(true);
    // Idempotent: setting the same value keeps the state identity stable.
    const stable = store.getState();
    store.setSignedIn(true);
    expect(store.getState()).toBe(stable);
  });

  it("seeds the sidebar from a cached list for an instant paint", () => {
    const store = new SessionStore();
    store.seedSessions([
      { sessionId: "s1", name: "Alpha" },
      { sessionId: "s2", name: "Beta" },
    ]);
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    // A cache seed must never clobber a live list once one exists.
    store.seedSessions([{ sessionId: "s3", name: "Gamma" }]);
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    // The authoritative sessions.list still overwrites the seed.
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s9", name: "Live" }] } as never);
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(["s9"]);
  });

  it("ignores an empty or malformed cache seed", () => {
    const store = new SessionStore();
    const before = store.getState();
    store.seedSessions([]);
    store.seedSessions(null);
    store.seedSessions("nonsense");
    // No rows to paint => state identity is untouched (no needless re-render).
    expect(store.getState()).toBe(before);
    expect(store.getState().sessions).toEqual([]);
  });

  it("builds a transcript from session.history messages", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      name: "Fix bug",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "**hi**" }] },
      ],
    });
    const s = store.getState();
    expect(s.activeSessionId).toBe("s1");
    expect(s.activeTitle).toBe("Fix bug");
    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[0]!.role).toBe("user");
    // History entries carry raw text; markdown is rendered lazily by the view.
    expect(toHtml(s.transcript[1]!.text)).toContain("<strong>hi</strong>");
  });

  it("stores a session's advertised commands per session (not on the runtime row)", () => {
    const store = new SessionStore();
    // Catalog list (as from /api/runtimes) — no agent commands yet.
    store.apply({
      type: "runtimes.list",
      runtimes: [{ id: "agent-x", displayName: "Agent X", capabilities: { toolInterception: true, interactiveTui: true } }],
    });
    // A session opens; its broadcast carries the runtime's hello-refined caps,
    // including agent-native slash commands.
    store.apply({
      type: "session.created",
      sessionId: "s1",
      runtimeId: "agent-x",
      capabilities: { toolInterception: true, commands: [{ name: "/compact", description: "Compact" }] },
    });
    // Commands live per session, keyed by sessionId, for the composer to read.
    expect(store.getState().commandsBySession["s1"]).toEqual([{ name: "/compact", description: "Compact" }]);
    // The shared runtime row is NOT mutated with the session's commands…
    const caps = store.getState().runtimes.find((r) => r.id === "agent-x")!.capabilities as Record<string, unknown>;
    expect(caps.commands).toBeUndefined();
    // …but other refined caps still fold onto the row, and catalog-only fields survive.
    expect(caps.interactiveTui).toBe(true);
  });

  it("keeps two sessions on the same runtime isolated (no cross-session clobber)", () => {
    const store = new SessionStore();
    store.apply({ type: "runtimes.list", runtimes: [{ id: "pi", displayName: "Pi", capabilities: { toolInterception: true } }] });
    store.apply({ type: "session.created", sessionId: "s1", runtimeId: "pi", capabilities: { commands: [{ name: "/one" }] } });
    store.apply({ type: "session.created", sessionId: "s2", runtimeId: "pi", capabilities: { commands: [{ name: "/two" }] } });
    // Each session keeps its own set — s2 does not overwrite s1 (the old per-runtime bug).
    expect(store.getState().commandsBySession["s1"]).toEqual([{ name: "/one" }]);
    expect(store.getState().commandsBySession["s2"]).toEqual([{ name: "/two" }]);
  });

  it("carries a command's invocation mode through and drops malformed entries", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.capabilities",
      sessionId: "s1",
      runtimeId: "shim",
      capabilities: {
        commands: [
          { name: "/deploy", description: "Deploy", mode: "protocol" },
          { name: "no-slash" }, // dropped
          { name: "/x", mode: "nonsense" }, // mode dropped, command kept
        ],
      },
    });
    expect(store.getState().commandsBySession["s1"]).toEqual([
      { name: "/deploy", description: "Deploy", mode: "protocol" },
      { name: "/x" },
    ]);
  });

  it("stores commands learned mid-session (session.capabilities) per session", () => {
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      runtimes: [{ id: "claude", displayName: "Claude Code", capabilities: { toolInterception: true } }],
    });
    // Claude's slash commands arrive only after the first turn's system/init,
    // via a standalone session.capabilities broadcast.
    store.apply({
      type: "session.capabilities",
      sessionId: "s1",
      runtimeId: "claude",
      capabilities: { toolInterception: true, commands: [{ name: "/compact" }, { name: "/review" }] },
    });
    expect(store.getState().commandsBySession["s1"]).toEqual([{ name: "/compact" }, { name: "/review" }]);
    // Still not on the runtime row.
    const caps = store.getState().runtimes.find((r) => r.id === "claude")!.capabilities as Record<string, unknown>;
    expect(caps.commands).toBeUndefined();
  });

  it("drops a session's commands on delete and clears them on node switch", () => {
    const store = new SessionStore();
    store.apply({ type: "session.created", sessionId: "s1", runtimeId: "pi", capabilities: { commands: [{ name: "/one" }] } });
    store.apply({ type: "session.deleted", sessionId: "s1" });
    expect(store.getState().commandsBySession["s1"]).toBeUndefined();
    store.apply({ type: "session.created", sessionId: "s2", runtimeId: "pi", capabilities: { commands: [{ name: "/two" }] } });
    store.resetSession();
    expect(store.getState().commandsBySession).toEqual({});
  });

  it("carries the repo-list unauthed reason so the picker can prompt to connect GitHub", () => {
    const store = new SessionStore();
    // Nothing connected and no gh CLI: steer to `bivy github:connect`.
    store.apply({ type: "repos.list", authed: false, repos: [], reason: "no-token" } as never);
    expect(store.getState().reposAuthed).toBe(false);
    expect(store.getState().reposReason).toBe("no-token");
    // gh installed but logged out: the picker additionally offers `gh auth login`.
    store.apply({ type: "repos.list", authed: false, repos: [], reason: "gh-unauthed" } as never);
    expect(store.getState().reposReason).toBe("gh-unauthed");
    // A successful listing clears the reason and marks authed.
    store.apply({ type: "repos.list", authed: true, repos: [{ slug: "acme/app" }] } as never);
    expect(store.getState().reposAuthed).toBe(true);
    expect(store.getState().reposReason).toBeNull();
    // An unknown/absent reason never leaks through as a truthy value.
    store.apply({ type: "repos.list", authed: false, repos: [] } as never);
    expect(store.getState().reposReason).toBeNull();
  });

  it("tracks the Connect-GitHub device flow so the repo picker can drive it", () => {
    const store = new SessionStore();
    expect(store.getState().githubConnect).toEqual({ status: "idle" });
    // Optimistic local state before the node answers.
    store.setGithubConnect({ status: "starting" });
    expect(store.getState().githubConnect.status).toBe("starting");
    // Node hands back a device code to show the user.
    store.apply({
      type: "github.connect.status",
      status: "waiting",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      intervalMs: 5000,
    } as never);
    expect(store.getState().githubConnect).toMatchObject({ status: "waiting", userCode: "ABCD-1234", intervalMs: 5000 });
    // Success clears back to a terminal state the picker reacts to.
    store.apply({ type: "github.connect.status", status: "connected" } as never);
    expect(store.getState().githubConnect.status).toBe("connected");
    // A node with no device-flow client id tells the UI to fall back to the CLI.
    store.apply({ type: "github.connect.status", status: "unconfigured" } as never);
    expect(store.getState().githubConnect.status).toBe("unconfigured");
    // An unknown status never leaks through — it collapses to idle.
    store.apply({ type: "github.connect.status", status: "bogus" } as never);
    expect(store.getState().githubConnect.status).toBe("idle");
    // Error carries its message.
    store.apply({ type: "github.connect.status", status: "error", error: "nope" } as never);
    expect(store.getState().githubConnect).toMatchObject({ status: "error", error: "nope" });
  });

  it("keeps the current node online when a stale registry snapshot races the live transport", () => {
    const store = new SessionStore();
    store.setCurrentNode("new-node");
    store.setNodes([
      { id: "new-node", name: "New node", online: false },
      { id: "other", name: "Other", online: false },
    ]);

    // The relay connection is direct evidence that this selected node is live.
    store.setStatus("online");
    expect(store.getState().nodes.find((n) => n.id === "new-node")?.online).toBe(true);

    // The relay's fire-and-forget control-plane write may still be in flight;
    // that late list must not turn the dot grey again.
    store.setNodes([
      { id: "new-node", name: "New node", online: false },
      { id: "other", name: "Other", online: false },
    ]);
    expect(store.getState().nodes.find((n) => n.id === "new-node")?.online).toBe(true);
    expect(store.getState().nodes.find((n) => n.id === "other")?.online).toBe(false);

    // Closing this browser transport (for example, to switch nodes) is not proof
    // that the daemon went offline, so it must not undo account presence.
    store.setStatus("offline");
    expect(store.getState().nodes.find((n) => n.id === "new-node")?.online).toBe(true);
  });

  it("clears nodeSettings on node switch so a new node's panel never shows the previous node's settings (issue #75)", () => {
    const store = new SessionStore();
    store.apply({
      type: "node.settings",
      settings: { name: "node-a", defaultAgent: "claude", githubIssuePrompt: "a-prompt" },
    });
    expect(store.getState().nodeSettings?.name).toBe("node-a");
    // Switching nodes must drop the stale settings immediately — if the newly
    // selected node is offline it may never answer node.settings.get, and
    // without this reset the UI would go on showing node-a's settings as if
    // they belonged to the new node.
    store.resetSession();
    expect(store.getState().nodeSettings).toBeNull();
  });

  it("leaves state identity stable when session.created adds no new capabilities or commands", () => {
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      runtimes: [{ id: "agent-x", displayName: "Agent X", capabilities: { toolInterception: true } }],
    });
    const beforeRuntimes = store.getState().runtimes;
    const beforeCommands = store.getState().commandsBySession;
    store.apply({ type: "session.created", sessionId: "s1", runtimeId: "agent-x", capabilities: { toolInterception: true } });
    // Nothing changed → same array/map identity, so no needless re-render.
    expect(store.getState().runtimes).toBe(beforeRuntimes);
    expect(store.getState().commandsBySession).toBe(beforeCommands);
  });

  it("classifies an agent API/auth error as an error bubble on reload, not a grey reply", () => {
    // The claude CLI prints API/auth failures (401s, dropped sockets) as an
    // ordinary assistant *text* message — persisted with no structured error
    // flag. On reload it must read as an error, not as the agent's answer.
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      name: "t",
      messages: [
        { role: "user", content: "Status?" },
        { role: "assistant", content: [{ type: "text", text: "Failed to authenticate. API Error: 401 Invalid authentication credentials" }] },
        { role: "assistant", content: [{ type: "text", text: "All 58 suites pass. Committing now." }] },
      ],
    });
    const tx = store.getState().transcript;
    expect(tx.find((e) => e.text.startsWith("Failed to authenticate"))!.role).toBe("error");
    // A normal reply is untouched — no false positive.
    expect(tx.find((e) => e.text.startsWith("All 58 suites"))!.role).toBe("assistant");
  });

  it("classifies a live agent API error on message_end as an error bubble", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant" } });
    store.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "API Error: 401 Invalid authentication credentials" }] } });
    const tx = store.getState().transcript;
    expect(tx.some((e) => e.role === "assistant")).toBe(false);
    const err = tx.find((e) => e.role === "error");
    expect(err).toBeDefined();
    expect(err!.text).toContain("API Error: 401");
  });

  it("previews in-flight prose as a plain-text streaming bubble, then seals it whole on message_end", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant" } });
    // A token update now paints a live preview so a session the user switches
    // back to mid-turn shows the agent's current answer immediately — but as
    // plain text (no per-update markdown pass; that churn is why streaming prose
    // used to be deferred to boundaries).
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
    const streaming = store.getState().transcript.filter((e) => e.role === "assistant");
    expect(streaming).toHaveLength(1);
    expect(streaming[0]!.streaming).toBe(true);
    expect(streaming[0]!.text).toBe("partial");
    expect(streaming[0]!.html).toBeUndefined(); // rendered as plain text while streaming
    expect(store.getState().working).toBe(true); // the working indicator still signals activity
    // The finished message seals in place — the same single bubble, now whole and
    // markdown-rendered, never a leftover streaming draft alongside it.
    store.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } });
    const assistant = store.getState().transcript.filter((e) => e.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe("final answer");
    expect(assistant[0]!.streaming).toBe(false);
    expect(assistant[0]!.html).toBeDefined(); // markdown rendered once it seals
  });

  it("replaces a streaming preview with an error bubble when the sealed run is an agent error", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant" } });
    // A partial that doesn't yet read as an error paints a live preview…
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "API Error: 401" }] } });
    expect(store.getState().transcript.filter((e) => e.role === "assistant")).toHaveLength(1);
    // …but once it seals and classifies as an error, the plain-text preview is
    // dropped (no orphan assistant bubble) and a single error bubble remains.
    store.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "API Error: 401 Invalid authentication credentials" }] } });
    const tx = store.getState().transcript;
    expect(tx.some((e) => e.role === "assistant")).toBe(false);
    expect(tx.filter((e) => e.role === "error")).toHaveLength(1);
    expect(tx.find((e) => e.role === "error")!.text).toContain("API Error: 401");
  });

  it("renders Pi toolResult messages as tool output, not assistant prose", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      name: "t",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/server.ts" } }] },
        { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "function main() {}" }], isError: false },
      ],
    });
    const tx = store.getState().transcript;
    expect(tx).toHaveLength(1);
    expect(tx[0]!.text).toBe("");
    expect(tx[0]!.tool).toMatchObject({ callId: "call_1", name: "read", status: "done", result: "function main() {}" });
  });

  it("joins multiple assistant text blocks with a newline, not a bare concat", () => {
    // Regression: some runtimes emit an assistant message's content as several
    // discrete "text" blocks (unlike a single accumulating delta). Joining
    // them with "" can weld prose directly onto a fenced code block's ```
    // marker (no separating whitespace at all), which knocks the fence off
    // its own line and breaks fence detection in the markdown renderer — the
    // whole message then falls through to one unstyled paragraph. See the
    // "renders a fenced code block split across content blocks" test below
    // for the end-to-end symptom this guards against.
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      name: "t",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Here is the file:" }, { type: "text", text: "```js\nconst x = 1;\n```" }] },
      ],
    });
    const entry = store.getState().transcript.at(-1)!;
    expect(entry.text).toBe("Here is the file:\n```js\nconst x = 1;\n```");
  });

  it("renders a fenced code block split across content blocks as a real code block", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      name: "t",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Here is the file:" }, { type: "text", text: "```js\nconst x = 1;\n```" }] },
      ],
    });
    const entry = store.getState().transcript.at(-1)!;
    // The joined text is what must render as a real fenced block once the view
    // (or anyone) markdowns it — the store leaves html unset for history entries.
    const html = toHtml(entry.text);
    expect(html).toContain("<pre><code");
    expect(html).not.toMatch(/```/);
  });

  it("accumulates reasoning from thinking_delta chunks and commits it whole on message_end", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant" } });
    // Runtime streams reasoning only as incremental deltas (empty message content).
    store.apply({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "Let me " } });
    store.apply({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "think about it." } });
    // The deltas accumulate but nothing renders mid-stream.
    expect(store.getState().transcript.some((e) => e.role === "thinking")).toBe(false);
    // Then the real answer streams and the turn finalizes.
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] } });
    store.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Answer." }] } });
    const s = store.getState();
    expect(s.transcript.find((e) => e.role === "thinking")!.text).toBe("Let me think about it."); // whole, accumulated
    expect(s.transcript.find((e) => e.role === "assistant")!.text).toBe("Answer.");
    expect(s.transcript.filter((e) => e.role === "thinking")).toHaveLength(1);
    expect(s.transcript.filter((e) => e.role === "assistant")).toHaveLength(1);
  });

  it("prefers an accumulated thinking block over deltas", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant" } });
    store.apply({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "Full reasoning so far" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "ignored" },
    });
    store.apply({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "Full reasoning so far" }] },
    });
    const thinking = store.getState().transcript.find((e) => e.role === "thinking")!;
    expect(thinking.text).toBe("Full reasoning so far");
  });

  it("applies an append history delta onto the cached prefix", () => {
    const store = new SessionStore();
    const persisted: Array<{ count: number; hash: string; len: number }> = [];
    store.onHistoryPersist = (_sid, messages, count, hash) => persisted.push({ count, hash, len: messages.length });
    // Full snapshot of 2 messages.
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      count: 2,
      historyHash: "h2",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
      ],
    });
    expect(store.getState().transcript).toHaveLength(2);
    expect(store.getHistoryCursor("s1")).toEqual({ have: 2, haveToken: "h2" });
    // Append delta: only the new tail, keyed to the prefix we already hold.
    store.apply({
      type: "session.history",
      sessionId: "s1",
      mode: "append",
      baseCount: 2,
      count: 3,
      historyHash: "h3",
      messages: [{ role: "user", content: "three" }],
    });
    const s = store.getState();
    expect(s.transcript).toHaveLength(3); // prefix + appended, not just the tail
    expect(s.transcript.at(-1)!.text).toBe("three");
    expect(store.getHistoryCursor("s1")).toEqual({ have: 3, haveToken: "h3" });
    expect(persisted.at(-1)).toEqual({ count: 3, hash: "h3", len: 3 });
  });

  it("does not reorder the chat when an append delta's base has diverged", () => {
    // Regression: user sends a first prompt, the agent replies, the user sends a
    // second (steering) prompt. A racing append delta then arrives whose baseCount
    // no longer matches historyRaw (a slow seed / second in-flight request moved
    // the cursor). The old code treated that append TAIL as a full transcript,
    // dropped the first prompt, and withPendingUserEntries re-appended it at the
    // end — the first message jumped to newest and the second showed first.
    let refetched = 0;
    const store = new SessionStore();
    store.requestFreshHistory = () => { refetched++; };
    store.addUserMessage("MSG1", "cm1");
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", count: 1, historyHash: "h1", messages: [{ role: "user", content: "MSG1" }] });
    store.apply({ type: "session.user_message", sessionId: "s1", text: "MSG1", clientMessageId: "cm1" });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "reply1" }] } } });
    store.addUserMessage("MSG2", "cm2");
    store.apply({ type: "session.user_message", sessionId: "s1", text: "MSG2", clientMessageId: "cm2" });
    const before = store.getState().transcript.map((e) => `${e.role}:${e.text}`);
    expect(before).toEqual(["user:MSG1", "assistant:reply1", "user:MSG2"]);
    // Append delta with a base we don't hold (prev.count is 1, not 99).
    store.apply({
      type: "session.history", sessionId: "s1", isStreaming: true, mode: "append", baseCount: 99, count: 100,
      messages: [{ role: "assistant", content: [{ type: "text", text: "reply1" }] }, { role: "user", content: "MSG2" }],
    });
    // The unusable delta is discarded (order preserved) and a full refetch is asked for.
    expect(store.getState().transcript.map((e) => `${e.role}:${e.text}`)).toEqual(["user:MSG1", "assistant:reply1", "user:MSG2"]);
    expect(refetched).toBe(1);
    expect(store.getHistoryCursor("s1")).toEqual({}); // diverged cursor forgotten -> next request is full
  });

  it("seeds a transcript from the persistent cache before the node answers", () => {
    const store = new SessionStore();
    store.beginOpen("s9");
    expect(store.getState().transcript).toHaveLength(0);
    store.seedHistory("s9", [{ role: "user", content: "cached hi" }], 1, "hh");
    expect(store.getState().transcript).toHaveLength(1);
    expect(store.getHistoryCursor("s9")).toEqual({ have: 1, haveToken: "hh" });
  });

  it("defers a mid-turn history snapshot and re-requests fresh history at turn end", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", count: 1, historyHash: "h1", messages: [{ role: "user", content: "hi" }] });
    // A turn starts and streams.
    store.apply({ type: "message_start", message: { role: "assistant" } });
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "streaming answer" }] } });
    const streaming = store.getState().transcript;
    // A snapshot arrives mid-turn — must NOT clobber the live tail.
    let freshRequested = 0;
    store.requestFreshHistory = () => (freshRequested += 1);
    store.apply({ type: "session.history", sessionId: "s1", count: 2, historyHash: "h2", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [] }] });
    expect(store.getState().transcript).toEqual(streaming); // deferred, not applied
    // Turn ends → reconcile with fresh canonical history.
    store.apply({ type: "agent_end" });
    expect(freshRequested).toBe(1);
    expect(store.getState().working).toBe(false);
  });

  it("applies the initial open snapshot even when a live delta flipped working first", () => {
    // Opening an *active* session: a live message_update for it commonly arrives
    // before the open history snapshot and flips `working` true. The open-paint
    // must still apply (nothing to erase yet) rather than defer until agent_end.
    const store = new SessionStore();
    let freshRequested = 0;
    store.requestFreshHistory = () => (freshRequested += 1);
    store.beginOpen("s1");
    // Live delta for the just-opened session lands first → working flips true.
    store.apply({ type: "message_start", message: { role: "assistant" } });
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } });
    expect(store.getState().working).toBe(true);
    // The authoritative open snapshot arrives mid-turn — must PAINT, not defer.
    store.apply({ type: "session.history", sessionId: "s1", isStreaming: true, count: 2, historyHash: "h1", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "streaming" }] }] });
    expect(store.getState().transcript.some((e) => e.text === "hi")).toBe(true);
    expect(freshRequested).toBe(0); // applied, not deferred
    // The turn keeps streaming after the open-paint; a LATER unsolicited mid-turn
    // snapshot must defer again (open-paint was a one-shot, guard restored).
    store.apply({ type: "message_start", message: { role: "assistant" } });
    store.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "streaming more" }] } });
    const painted = store.getState().transcript;
    store.apply({ type: "session.history", sessionId: "s1", count: 3, historyHash: "h2", messages: [{ role: "user", content: "hi" }] });
    expect(store.getState().transcript).toEqual(painted); // deferred, not applied
  });

  it("merges tool start + result into a single card", () => {
    const store = new SessionStore();
    store.apply({ type: "tool_call", toolCallId: "t1", name: "bash", input: { cmd: "ls" } });
    store.apply({ type: "tool_result", toolCallId: "t1", name: "bash", result: "file.txt" });
    const tools = store.getState().transcript.filter((e) => e.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool!.status).toBe("done");
    expect(tools[0]!.tool!.result).toBe("file.txt");
  });

  it("surfaces a running delegated tool as active sub-agent work", () => {
    const store = new SessionStore();
    store.apply({
      type: "tool_call",
      toolCallId: "sub-1",
      name: "Task",
      input: { description: "trace auth" },
      detail: { kind: "delegation", label: "Explore", description: "trace auth" },
    });
    expect(store.getState().workingLabel).toBe("Explore sub-agent is working…");
    const tool = store.getState().transcript.find((entry) => entry.tool)?.tool;
    expect(tool?.detail).toEqual({ kind: "delegation", label: "Explore", description: "trace auth" });

    // Long-running agent tools emit elapsed-time progress with no repeated
    // detail. The card must retain its sub-agent identity while accepting the
    // fresh activity payload, rather than degrading back to an opaque tool. The
    // progress ping is MERGED onto the original input, so the delegation's task
    // description survives alongside the new elapsed marker instead of being
    // clobbered away.
    store.apply({ type: "tool_execution_update", toolCallId: "sub-1", name: "Task", input: { elapsedSeconds: 42 } });
    const updated = store.getState().transcript.find((entry) => entry.tool)?.tool;
    expect(updated?.detail?.kind).toBe("delegation");
    expect(updated?.input).toEqual({ description: "trace auth", elapsedSeconds: 42 });
    expect(store.getState().workingLabel).toBe("Explore sub-agent is working…");
  });

  it("carries a tool call's failure outcome (exitCode/isError) onto the done card", () => {
    const store = new SessionStore();
    store.apply({ type: "tool_call", toolCallId: "c1", name: "bash", input: { command: "make" }, detail: { kind: "shell", command: "make" } });
    store.apply({ type: "tool_result", toolCallId: "c1", name: "bash", result: "boom", detail: { kind: "shell", command: "make", result: { exitCode: 2, isError: true } } });
    const tool = store.getState().transcript.find((e) => e.tool?.callId === "c1")?.tool;
    expect(tool?.status).toBe("done");
    // The result-time detail (call classification + outcome) replaced the
    // call-time detail, so the UI can render this command as failed.
    expect(tool?.detail).toMatchObject({ kind: "shell", result: { exitCode: 2, isError: true } });
  });

  it("coalesces unnamed agent output updates into one live card", () => {
    const store = new SessionStore();
    store.apply({ type: "tool_execution_update", toolName: "agent_output", input: { stream: "stderr", output: "first" } });
    store.apply({ type: "tool_execution_update", toolName: "agent_output", input: { stream: "stderr", output: "first\nsecond" } });
    const tools = store.getState().transcript.filter((e) => e.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool!.input).toEqual({ stream: "stderr", output: "first\nsecond" });
    expect(store.getState().workingLabel).toBe("Reading agent output…");
  });

  it("force-closes a still-running tool card on agent_end (e.g. aborted mid-tool, no matching tool_result ever arrives)", () => {
    const store = new SessionStore();
    store.apply({ type: "tool_call", toolCallId: "t1", name: "bash", input: { cmd: "sleep 100" } });
    const running = store.getState().transcript.filter((e) => e.tool);
    expect(running).toHaveLength(1);
    expect(running[0]!.tool!.status).toBe("running");
    store.apply({ type: "agent_end" });
    const tools = store.getState().transcript.filter((e) => e.tool);
    expect(tools[0]!.tool!.status).toBe("done");
  });

  it("derives GitHub context from session.history", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.history", requestId: "r1",
      sessionId: "s1",
      source: "repo:acme/widgets",
      branch: "feature/x",
      prUrl: "https://github.com/acme/widgets/pull/9",
      messages: [],
    });
    const gh = store.getState().github;
    expect(gh.repo).toBe("acme/widgets");
    expect(gh.branch).toBe("feature/x");
    expect(gh.prUrl).toBe("https://github.com/acme/widgets/pull/9");
  });

  it("unwraps session.event envelopes so streamed agent messages render", () => {
    const store = new SessionStore();
    // The node always tags turn events with the sessionId inside a
    // `session.event` envelope — this is the real wire format.
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "message_start", message: { role: "assistant" } } });
    store.apply({
      type: "session.event",
      sessionId: "s1",
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello there" }] } },
    });
    const assistant = store.getState().transcript.filter((e) => e.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe("hello there");
  });

  it("ignores session.event for a different (non-focused) session", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", sessionId: "s1", messages: [] });
    store.apply({
      type: "session.event",
      sessionId: "other",
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "leak" }] } },
    });
    expect(store.getState().transcript).toHaveLength(0);
  });

  it("dedups the node's user_message echo against our optimistic bubble", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.addUserMessage("hi there", "cm-1");
    // The node echoes our own prompt back with the same clientMessageId.
    store.apply({ type: "session.user_message", sessionId: "s1", text: "hi there", clientMessageId: "cm-1" });
    expect(store.getState().transcript.filter((e) => e.role === "user")).toHaveLength(1);
    // A user_message from another client (no matching id) still renders.
    store.apply({ type: "session.user_message", sessionId: "s1", text: "from phone", clientMessageId: "cm-2" });
    expect(store.getState().transcript.filter((e) => e.role === "user")).toHaveLength(2);
  });

  it("keeps an optimistic user bubble through a new session's empty history", () => {
    const store = new SessionStore();
    // New-session flow: the bubble is shown, then session.new answers with an
    // empty history for the freshly created session.
    store.addUserMessage("build me a thing", "cm-new");
    expect(store.getState().transcript).toHaveLength(1);
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s-new", messages: [] });
    // The prompt must survive — not vanish leaving only a "working" row.
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("build me a thing");
    // Streamed reply then renders after it.
    store.apply({ type: "session.event", sessionId: "s-new", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } } });
    expect(store.getState().transcript.map((e) => e.role)).toEqual(["user", "assistant"]);
  });

  it("keeps the just-sent bubble when a stale/empty history races in after the echo (repo clone)", () => {
    // Regression (repo-session new-message flow): a repo-backed session clones
    // its worktree before the first turn, so there's a long window between the
    // session.new reply and the turn actually streaming. In that window the node
    // echoes our prompt (session.user_message) and a stale/empty history snapshot
    // can still be applied (a foreground/reconnect refresh, or a snapshot that
    // predates the first message being persisted). Dropping the optimistic bubble
    // on the echo made the message vanish ("back to scratch"), then only the
    // agent's reply showed, until canonical history finally restored it.
    const store = new SessionStore();
    store.addUserMessage("build me a thing", "cm-1");
    store.apply({ type: "session.cloning", repo: "owner/repo" });
    // session.new reply: empty history for the freshly created session (adopted
    // because it carries our requestId).
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s-new", messages: [] });
    expect(store.getState().transcript.filter((e) => e.role === "user")).toHaveLength(1);
    // The node echoes our own prompt back (it's now persisted server-side).
    store.apply({ type: "session.user_message", sessionId: "s-new", text: "build me a thing", clientMessageId: "cm-1" });
    // A stale/empty history snapshot races in before the turn streams. This must
    // NOT wipe the message the user just sent.
    store.apply({ type: "session.history", sessionId: "s-new", messages: [] });
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("build me a thing");
    // Canonical history finally carries the prompt — it must appear exactly once.
    store.apply({ type: "session.history", sessionId: "s-new", messages: [{ role: "user", content: "build me a thing" }, { role: "assistant", content: [{ type: "text", text: "on it" }] }] });
    expect(store.getState().transcript.filter((e) => e.role === "user")).toHaveLength(1);
    expect(store.getState().transcript.map((e) => e.role)).toEqual(["user", "assistant"]);
  });

  it("does not duplicate the optimistic bubble once the node echoes and history catches up", () => {
    const store = new SessionStore();
    store.addUserMessage("hello node", "cm-x");
    store.apply({ type: "session.history", sessionId: "s1", messages: [] });
    // Node echoes our own prompt (dedup path) — it is now persisted server-side.
    store.apply({ type: "session.user_message", sessionId: "s1", text: "hello node", clientMessageId: "cm-x" });
    // A later canonical history now contains the message; it must appear once.
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "hello node" }] });
    expect(store.getState().transcript.filter((e) => e.role === "user")).toHaveLength(1);
  });

  it("retires a confirmed bubble the runtime rewrote, instead of re-appending it at the bottom every snapshot", () => {
    // Regression: as the agent works it streams canonical history snapshots. Some
    // runtimes persist the user turn wrapped in context (env_context, normalized
    // whitespace, etc.) so its text matches neither the raw text we rendered nor
    // the node's session.user_message echo. Exact-text dedup then failed and the
    // optimistic bubble was re-appended to the BOTTOM of the chat on every snapshot
    // — the "last user message keeps getting added to the bottom" bug. Once the
    // node has confirmed the prompt (echo) and history has grown to hold it, it
    // must be retired by count even without a text match.
    const store = new SessionStore();
    store.requestFreshHistory = () => {};
    store.apply({ type: "session.history", requestId: "r0", sessionId: "s1", count: 2, historyHash: "h0", messages: [
      { role: "user", content: "old prompt" },
      { role: "assistant", content: [{ type: "text", text: "old reply" }] },
    ] });
    store.addUserMessage("do X", "cm1");
    store.apply({ type: "session.user_message", sessionId: "s1", text: "do X", clientMessageId: "cm1" });
    const persistedUser = "do X\n\n<environment_context>cwd=/repo</environment_context>";
    for (let i = 0; i < 3; i++) {
      store.apply({ type: "session.event", sessionId: "s1", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step " + i }] } } });
      store.apply({ type: "session.history", sessionId: "s1", isStreaming: true, count: 4, historyHash: "h" + i, messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "text", text: "old reply" }] },
        { role: "user", content: persistedUser },
        { role: "assistant", content: [{ type: "text", text: "step " + i }] },
      ] });
    }
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(2); // old prompt + the steering prompt, not duplicated
    // The steering prompt sits in place (before the agent's reply), never trailing it.
    expect(store.getState().transcript.map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("does not retire an unconfirmed bubble on a count-matching snapshot (only the node's echo confirms persistence)", () => {
    // The count fallback must apply only to prompts the node has echoed. Without an
    // echo, a snapshot whose user count merely happens to match (e.g. another
    // client's message, or a stale count) must not silently drop our just-sent —
    // still-unpersisted — prompt.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r0", sessionId: "s1", messages: [] });
    store.addUserMessage("mine", "cm1");
    // A snapshot with a same-count user message from ELSEWHERE, no echo for cm1 yet.
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "from another device" }] });
    const users = store.getState().transcript.filter((e) => e.role === "user").map((e) => e.text);
    expect(users).toEqual(["from another device", "mine"]); // ours survives, appended
  });

  it("keeps a sent attachment visible through a later history-based re-render", () => {
    // Regression: attachments were dropped entirely once the optimistic bubble
    // was replaced by a canonical history snapshot — the node only ever
    // persists a text placeholder for an attachment, never the real bytes. The
    // store now remembers attachments by message text (attachmentsByText) and
    // re-attaches them onto any later-rendered entry with matching text.
    const store = new SessionStore();
    const attachments = [{ kind: "image" as const, name: "shot.png", size: 12345, mimeType: "image/png", data: "Zm9v" }];
    store.addUserMessage("look at this", "cm-1", attachments);
    expect(store.getState().transcript[0]!.attachments).toEqual(attachments);
    store.apply({ type: "session.history", sessionId: "s1", messages: [] });
    // Still present while the bubble is only the optimistic (pending) one.
    expect(store.getState().transcript[0]!.attachments).toEqual(attachments);
    store.apply({ type: "session.user_message", sessionId: "s1", text: "look at this", clientMessageId: "cm-1" });
    // Canonical history replaces the entry entirely (new id, no attachments of
    // its own) — the cache re-attaches by matching text.
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "look at this" }] });
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.attachments).toEqual(attachments);
  });

  it("re-attaches an image sent with a caption even when the node echoes composed text", () => {
    // Regression: the node persists `[caption, attachmentPlaceholder].join("\n\n")`
    // (src/server.ts's attachmentsFrom), not the raw caption the client sent —
    // so keying the cache on the raw caption alone missed every later
    // history-based re-render, and the message fell back to showing the node's
    // bare "[Image attachment: ...]" placeholder text instead of the thumbnail.
    const store = new SessionStore();
    const attachments = [{ kind: "image" as const, name: "shot.png", size: 12345, mimeType: "image/png", data: "Zm9v" }];
    store.addUserMessage("check this out", "cm-1", attachments);
    store.apply({ type: "session.history", sessionId: "s1", messages: [] });
    const composed = "check this out\n\n[Image attachment: shot.png (12345 bytes)]";
    store.apply({ type: "session.user_message", sessionId: "s1", text: composed, clientMessageId: "cm-1" });
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: composed }] });
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.attachments).toEqual(attachments);
  });

  it("re-attaches an image sent with no caption text at all", () => {
    // Regression: rememberAttachments skipped caching entirely for an empty
    // raw caption (falsy `text` guard), so an attachment-only message (no
    // typed text) could never be re-attached once history replaced it.
    const store = new SessionStore();
    const attachments = [{ kind: "image" as const, name: "shot.png", size: 12345, mimeType: "image/png", data: "Zm9v" }];
    store.addUserMessage("", "cm-1", attachments);
    store.apply({ type: "session.history", sessionId: "s1", messages: [] });
    const composed = "[Image attachment: shot.png (12345 bytes)]";
    store.apply({ type: "session.user_message", sessionId: "s1", text: composed, clientMessageId: "cm-1" });
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: composed }] });
    const users = store.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.attachments).toEqual(attachments);
  });

  it("round-trips attachments through a persisted snapshot across a reload", () => {
    // Regression: attachmentsByText is in-memory only and doesn't survive a
    // reload (routine on iOS, which kills a backgrounded PWA's JS context) —
    // after that, a session whose history is re-seeded from the persistent
    // transcript cache would show the node's plain-text placeholder forever.
    // The controller now persists attachmentsForHistory() alongside the raw
    // messages and calls restoreAttachments() before seedHistory on the next
    // load; simulate that here with two separate SessionStore instances.
    const before = new SessionStore();
    const attachments = [{ kind: "image" as const, name: "shot.png", size: 12345, mimeType: "image/png", data: "Zm9v" }];
    before.addUserMessage("look at this", "cm-1", attachments);
    const messages = [{ role: "user", content: "look at this" }];
    const persisted = before.attachmentsForHistory(messages);
    expect(persisted).toEqual([["look at this", attachments]]);

    // A fresh store — as if the page reloaded — has nothing until restored.
    const after = new SessionStore();
    expect(after.attachmentsForHistory(messages)).toEqual([]);
    after.restoreAttachments(persisted);
    after.beginOpen("s1");
    after.seedHistory("s1", messages, 1, "hash1");
    const users = after.getState().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.attachments).toEqual(attachments);
  });

  it("does not repaint the view when history arrives for a session the user left", () => {
    const store = new SessionStore();
    // Open A, then quickly switch to B before A's history lands.
    store.beginOpen("A");
    store.apply({ type: "session.history", sessionId: "A", name: "Session A", messages: [{ role: "user", content: "a1" }] });
    store.beginOpen("B");
    store.apply({ type: "session.history", sessionId: "B", name: "Session B", messages: [{ role: "user", content: "b1" }] });
    expect(store.getState().activeSessionId).toBe("B");
    // A's (slow) history now arrives — it must NOT hijack the view back to A.
    store.apply({ type: "session.history", sessionId: "A", name: "Session A", messages: [{ role: "user", content: "a1" }, { role: "assistant", content: [{ type: "text", text: "a-reply" }] }] });
    expect(store.getState().activeSessionId).toBe("B");
    expect(store.getState().activeTitle).toBe("Session B");
    expect(store.getState().transcript.some((e) => e.text === "b1")).toBe(true);
    expect(store.getState().transcript.some((e) => e.text === "a-reply")).toBe(false);
  });

  it("reconciles the open session on reconnect and clears a stuck working flag", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [{ role: "user", content: "go" }] });
    // A turn starts streaming, then the connection drops mid-turn.
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    expect(store.getState().working).toBe(true);
    store.markStreamInterrupted();
    // Reconnect: fresh history says the turn is done. It must apply (not be
    // deferred forever as "mid-turn") and clear working.
    store.apply({ type: "session.history", sessionId: "s1", isStreaming: false, messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "done" }] }] });
    expect(store.getState().working).toBe(false);
    expect(store.getState().transcript.some((e) => e.text === "done")).toBe(true);
  });

  it("clears the sidebar needs-action dot when its approval resolves", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({ type: "approval.created", approval: { id: "a1", sessionId: "s1", tool: "bash" } });
    expect(store.getState().sessions[0]!.needsAction).toBe(true);
    store.apply({ type: "approval.resolved", id: "a1" });
    expect(store.getState().sessions[0]!.needsAction).toBe(false);
    expect(store.getState().sessions[0]!.status).toBe("idle");
  });

  it("tracks live bivy run terminals from list and lifecycle events", () => {
    const store = new SessionStore();
    store.apply({
      type: "terminal.list",
      terminals: [{ termId: "term-1", name: "Pi · mesh", agent: "pi", createdAt: 100, lastActivityAt: 100 }],
    });
    expect(store.getState().runTerminals.map((t) => t.termId)).toEqual(["term-1"]);

    store.apply({ type: "terminal.activity", termId: "term-1", at: 200 });
    expect(store.getState().runTerminals[0]!.lastActivityAt).toBe(200);

    store.apply({ type: "terminal.created", terminal: { termId: "term-2", name: "Codex · repo", agent: "codex", createdAt: 300 } });
    expect(store.getState().runTerminals.map((t) => t.termId)).toEqual(["term-2", "term-1"]);

    store.apply({ type: "terminal.closed", termId: "term-1" });
    expect(store.getState().runTerminals.map((t) => t.termId)).toEqual(["term-2"]);
  });

  it("keeps sessions and run terminals across a node switch — they're unified all-node sidebar lists, not per-node state (issue #99)", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One", nodeId: "node-a" }] });
    store.apply({
      type: "terminal.list",
      terminals: [{ termId: "term-1", name: "Pi · mesh", agent: "pi", nodeId: "node-a" }],
    });
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(store.getState().runTerminals.map((t) => t.termId)).toEqual(["term-1"]);
    // resetSession() is what controller.switchNode() calls when the user picks
    // a different node (e.g. from the "new session" node switcher) — it must
    // still blank the active session pane, but the sidebar's session/terminal
    // lists (spanning every node on the account) must not change just because
    // the client's own connected transport did.
    store.resetSession();
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(store.getState().runTerminals.map((t) => t.termId)).toEqual(["term-1"]);
    expect(store.getState().activeSessionId).toBeNull();
  });

  // ---- seen/unseen + live/not-live state (issue #387) ----
  // finishedAt/lastSeenAt are the client-local fields the web package's
  // isUnseen() derives its "finished but not yet seen" dot from. These tests
  // pin down the store invariants that derivation depends on.

  it("stamps finishedAt only on the real agent_end transition to idle, not on other activity", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    expect(store.getState().sessions[0]!.finishedAt).toBeUndefined();
    // Mid-turn activity on a session that isn't focused moves it to "working"
    // — not a finish, so no finishedAt yet.
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    expect(store.getState().sessions[0]!.status).toBe("working");
    expect(store.getState().sessions[0]!.finishedAt).toBeUndefined();
    // The turn actually finishing is what stamps it.
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_end" } });
    expect(store.getState().sessions[0]!.status).toBe("idle");
    expect(store.getState().sessions[0]!.finishedAt).toBeTypeOf("number");
  });

  it("never stamps finishedAt for a brand-new session or a cold sessions.list snapshot", () => {
    // A session reported "idle" by a fresh sessions.list (e.g. on load/reconnect)
    // must not read as an unseen finished run — only a live agent_end transition
    // observed by this client counts as "just finished".
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", status: "idle" }] });
    expect(store.getState().sessions[0]!.finishedAt).toBeUndefined();
  });

  it("beginOpen stamps lastSeenAt on the opened row", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    expect(store.getState().sessions[0]!.lastSeenAt).toBeUndefined();
    store.beginOpen("s1");
    expect(store.getState().sessions[0]!.lastSeenAt).toBeTypeOf("number");
  });

  it("keeps the active session's lastSeenAt current as its own live updates land, but not a background session's", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }, { id: "s2", name: "Two" }] });
    store.beginOpen("s1");
    const seenAtOpen = store.getState().sessions.find((s) => s.sessionId === "s1")!.lastSeenAt;
    expect(seenAtOpen).toBeTypeOf("number");
    // The focused session finishing a run must not flag itself unseen — the
    // user is already looking at it.
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_end" } });
    const s1 = store.getState().sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.finishedAt).toBeTypeOf("number");
    expect(s1.lastSeenAt).toBeGreaterThanOrEqual(s1.finishedAt!);
    // A different, unfocused session finishing meanwhile must NOT get its
    // lastSeenAt bumped — nobody's looking at it.
    store.apply({ type: "session.event", sessionId: "s2", event: { type: "agent_end" } });
    const s2 = store.getState().sessions.find((s) => s.sessionId === "s2")!;
    expect(s2.finishedAt).toBeTypeOf("number");
    expect(s2.lastSeenAt).toBeUndefined();
  });

  it("preserves lastSeenAt/finishedAt across a routine sessions.list refresh", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_end" } });
    const finishedAt = store.getState().sessions[0]!.finishedAt;
    expect(finishedAt).toBeTypeOf("number");
    // A later poll re-fetches the list from scratch (the node has no notion of
    // these client-local fields) — they must survive the rebuild.
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", status: "idle" }] });
    expect(store.getState().sessions[0]!.finishedAt).toBe(finishedAt);
  });

  it("keeps each session's on-disk path so a sidebar tap can open it", () => {
    // Regression: the sidebar sends `session.open` with the session's path; the
    // node ignores an open with no path, so a stored (not-yet-loaded) session
    // wouldn't load and the pane looked like a brand-new session. The path must
    // survive normalization for SessionList → openSession to forward it.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", path: "/w/s1.jsonl" }] });
    expect(store.getState().sessions[0]!.path).toBe("/w/s1.jsonl");
  });

  it("opening a known session keeps its name and last-active time (no Untitled, no reorder)", () => {
    // Opening a session resumes it on the node, which re-broadcasts
    // session.created with no name and no fresh timestamp. That must not clobber
    // the sidebar row: it kept surfacing the real title as "Untitled session"
    // and bumping the row to the top as if it had just been active.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "Fix the parser", path: "/w/s1", updatedAt: 1000 }] });
    store.apply({ type: "session.created", sessionId: "s1", runtimeId: "pi" });
    const row = store.getState().sessions.find((s) => s.sessionId === "s1")!;
    expect(row.name).toBe("Fix the parser");
    expect(row.updatedAt).toBe(1000);
  });

  it("session.created still fills a default name/time for a genuinely new row", () => {
    const store = new SessionStore();
    store.apply({ type: "session.created", sessionId: "new1", runtimeId: "pi" });
    const row = store.getState().sessions.find((s) => s.sessionId === "new1")!;
    expect(row.name).toBe("Untitled session");
    expect(typeof row.updatedAt).toBe("number");
  });

  it("beginOpen updates the header title from the known row immediately", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s2", name: "Ship the PR", path: "/w/s2", updatedAt: 2000 }] });
    store.beginOpen("s2");
    expect(store.getState().activeTitle).toBe("Ship the PR");
  });

  it("beginOpen replaces the New-session agent/model pills with session-scoped metadata", () => {
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "claude", displayName: "Claude Code" },
      runtimes: [
        { id: "claude", displayName: "Claude Code" },
        { id: "codex", displayName: "Codex" },
      ],
    });
    store.apply({
      type: "models.list",
      runtimeId: "claude",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "sonnet", provider: "anthropic" }],
    });
    store.apply({
      type: "sessions.list",
      sessions: [{ id: "s2", name: "Codex session", runtimeId: "codex", agentName: "Codex" }],
    });

    // These are the selections visible on the New session screen.
    expect(store.getState().currentAgentName).toBe("Claude Code");
    expect(store.getState().currentModel?.id).toBe("sonnet");

    store.beginOpen("s2");
    expect(store.getState().currentAgentName).toBe("Codex");
    expect(store.getState().activeRuntimeId).toBe("codex");
    expect(store.getState().currentModel).toBeNull();
    expect(store.getState().models).toEqual([]);

    // The session-scoped refresh fills in that session's actual model.
    store.apply({
      type: "models.list",
      sessionId: "s2",
      runtimeId: "codex",
      current: { id: "gpt-5.4", provider: "openai" },
      models: [{ id: "gpt-5.4", provider: "openai" }],
    });
    expect(store.getState().currentModel?.id).toBe("gpt-5.4");
  });

  it("tracks the active session runtime independently from the global agent selection", () => {
    const store = new SessionStore();
    store.setSelectedAgentLocal("pi");
    store.apply({ type: "sessions.list", sessions: [{ id: "s2", name: "Claude session", runtimeId: "pi" }] });
    store.beginOpen("s2");
    expect(store.getState().activeRuntimeId).toBe("pi");

    // Canonical history wins over a stale list row/global last-used agent.
    store.apply({ type: "session.history", sessionId: "s2", runtimeId: "claude-code-sdk", agentName: "Claude Code SDK", messages: [] });
    expect(store.getState().activeRuntimeId).toBe("claude-code-sdk");
    expect(store.getState().selectedAgentId).toBe("pi");

    store.resetActiveSession();
    expect(store.getState().activeRuntimeId).toBeNull();
  });

  it("keeps the agent pill and picker on the active session when runtimes refresh", () => {
    const store = new SessionStore();
    store.apply({
      type: "session.history",
      requestId: "r1",
      sessionId: "s1",
      runtimeId: "opencode",
      agentName: "OpenCode",
      messages: [],
    });

    // Opening the agent sheet requests runtimes.list. `current` is the default
    // for new sessions (Pi), while activeRuntimeId is the agent this session
    // actually uses (OpenCode). The refresh must not change the pill to Pi while
    // the sheet correctly keeps its checkmark on OpenCode.
    store.apply({
      type: "runtimes.list",
      current: { id: "pi", displayName: "Pi" },
      activeAgent: "opencode",
      runtimes: [
        { id: "opencode", displayName: "OpenCode" },
        { id: "pi", displayName: "Pi" },
      ],
    });

    const state = store.getState();
    expect(state.activeRuntimeId).toBe("opencode");
    expect(state.currentAgentName).toBe("OpenCode");
    // The node default may still be remembered for a future draft without
    // leaking into the active session's display.
    expect(state.selectedAgentId).toBe("pi");
  });

  it("beginOpen primes the GitHub pill from the known row so it shows without waiting on history", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [{ id: "s2", name: "Ship the PR", path: "/w/s2", source: "repo:acme/widgets", branch: "feat/x", prs: [{ url: "https://github.com/acme/widgets/pull/9", state: "open" }] }],
    });
    store.beginOpen("s2");
    const gh = store.getState().github;
    expect(gh.prUrl).toBe("https://github.com/acme/widgets/pull/9");
    expect(gh.prs.map((p) => p.state)).toEqual(["open"]);
    expect(gh.branch).toBe("feat/x");
    expect(gh.repo).toBe("acme/widgets");
  });

  it("normalizes a forked session's parent id from sessions.list, and leaves it undefined for an ordinary session", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [
        { id: "fork1", name: "Retry the flaky test", forkedFrom: "parent1" },
        { id: "plain1", name: "Ordinary session" },
      ],
    });
    const fork = store.getState().sessions.find((s) => s.sessionId === "fork1");
    const plain = store.getState().sessions.find((s) => s.sessionId === "plain1");
    expect(fork?.forkedFrom).toBe("parent1");
    expect(plain?.forkedFrom).toBeUndefined();
  });

  it("beginOpen clears a previous session's pill when the next row has no PR", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [
        { id: "withpr", name: "Has PR", path: "/w/a", prs: [{ url: "https://github.com/a/b/pull/1", state: "open" }] },
        { id: "nopr", name: "No PR", path: "/w/b" },
      ],
    });
    store.beginOpen("withpr");
    expect(store.getState().github.prs).toHaveLength(1);
    store.beginOpen("nopr");
    expect(store.getState().github.prs).toEqual([]);
    expect(store.getState().github.prUrl).toBeNull();
  });

  it("dedupes sessions.list by sessionId so the sidebar never renders duplicate rows", () => {
    // The sidebar keys each row on sessionId; a list carrying the same id twice
    // (e.g. a node merging sessions from more than one runtime) would otherwise
    // render duplicate rows and trip React's duplicate-key warning. Keep the
    // first occurrence — the node sorts newest-first.
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [
        { id: "s1", name: "First", updatedAt: 200 },
        { id: "s1", name: "Stale copy", updatedAt: 100 },
        { id: "s2", name: "Other" },
      ],
    });
    const { sessions } = store.getState();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.sessionId === "s1")).toHaveLength(1);
    expect(sessions.find((s) => s.sessionId === "s1")!.name).toBe("First");
  });

  it("clears a stale model when a runtime reports no models", () => {
    const store = new SessionStore();
    store.apply({ type: "models.list", models: [{ id: "opus", provider: "anthropic" }], current: { id: "opus", provider: "anthropic" } });
    expect(store.getState().currentModel?.id).toBe("opus");
    // Switching to a runtime with no model selection (e.g. Codex).
    store.apply({ type: "models.list", models: [], current: null });
    expect(store.getState().currentModel).toBeNull();
    expect(store.getState().currentModelId).toBeNull();
  });

  it("drops a model the new runtime doesn't support instead of leaving a mismatch", () => {
    // Regression (agent/model mismatch): switching agents re-lists models, but
    // when the node doesn't echo an explicit `current`, the old selection used to
    // stick even if the new runtime didn't list it — so the composer showed (and
    // session.new would send) a model the agent can't use. It must fall back to
    // the runtime's default (first) model instead.
    const store = new SessionStore();
    store.apply({ type: "models.list", models: [{ id: "opus", provider: "anthropic" }], current: { id: "opus", provider: "anthropic" } });
    expect(store.getState().currentModel?.id).toBe("opus");
    // New agent supports a different model set that doesn't include opus, and the
    // node sends no explicit `current`.
    store.apply({ type: "models.list", models: [{ id: "grok-4", provider: "xai" }, { id: "grok-3", provider: "xai" }] });
    expect(store.getState().currentModel?.id).toBe("grok-4");
    expect((store.getState().currentModel as any)?.provider).toBe("xai");
  });

  it("keeps the current model across a refresh when the runtime still supports it", () => {
    const store = new SessionStore();
    store.apply({ type: "models.list", models: [{ id: "a", provider: "p" }, { id: "b", provider: "p" }], current: { id: "b", provider: "p" } });
    expect(store.getState().currentModel?.id).toBe("b");
    // A plain re-list (no explicit current) that still contains "b" must not
    // snap the selection back to the first model.
    store.apply({ type: "models.list", models: [{ id: "a", provider: "p" }, { id: "b", provider: "p" }] });
    expect(store.getState().currentModel?.id).toBe("b");
  });

  it("keeps an unconnected model in state.models but never auto-selects it as current (#390 'other models' section)", () => {
    // The model picker's "other models" section (#390) rides in the same
    // models.list payload as the connected ones, each flagged
    // `configured: false` by the node. The reducer must still surface them in
    // state.models (so the picker can render them + an inline connect action)
    // but must never let one become currentModel via any of the fallback
    // paths — a provider with no auth configured can't actually run a turn.
    const store = new SessionStore();
    store.apply({
      type: "models.list",
      models: [
        { id: "opus", provider: "anthropic" },
        { id: "gpt-5", provider: "openai", configured: false },
      ],
      current: { id: "opus", provider: "anthropic" },
    });
    expect(store.getState().models).toHaveLength(2);
    expect(store.getState().currentModel?.id).toBe("opus");
  });

  it("falls back to null (not an unconnected model) when nothing configured is left", () => {
    // If every configured model disappears (e.g. the last connected
    // provider's key was removed) but the node still lists unconnected
    // models for discovery, the fallback must treat that the same as "no
    // models" — never silently promote an unconnected model to current.
    const store = new SessionStore();
    store.apply({ type: "models.list", models: [{ id: "opus", provider: "anthropic" }], current: { id: "opus", provider: "anthropic" } });
    expect(store.getState().currentModel?.id).toBe("opus");
    store.apply({
      type: "models.list",
      models: [{ id: "gpt-5", provider: "openai", configured: false }],
      current: null,
    });
    expect(store.getState().currentModel).toBeNull();
  });

  it("defaults a fresh draft to the last-used model, ahead of the node default", () => {
    // A new session should open on whatever model the user last picked, as long
    // as this runtime lists it — even when the node names a different `current`.
    const store = new SessionStore();
    store.setDraftModel({ provider: "xai", id: "grok-4" });
    // The node offers grok-3 as its default `current`, but the user last used
    // grok-4 (which this runtime lists) — the remembered pick must win.
    store.apply({
      type: "models.list",
      current: { id: "grok-3", provider: "xai" },
      models: [{ id: "grok-3", provider: "xai" }, { id: "grok-4", provider: "xai" }],
    });
    expect(store.getState().currentModel?.id).toBe("grok-4");
  });

  it("ignores the last-used model the runtime doesn't list, and once a session is active", () => {
    const store = new SessionStore();
    // Remembered model the runtime doesn't offer → node default wins.
    store.setDraftModel({ provider: "xai", id: "grok-4" });
    store.apply({
      type: "models.list",
      current: { id: "opus", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    expect(store.getState().currentModel?.id).toBe("opus");

    // Once a session is active, its own `current` wins over the draft preference
    // even when the remembered model is listed.
    store.setDraftModel({ provider: "xai", id: "grok-4" });
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({
      type: "models.list",
      sessionId: "s1",
      current: { id: "grok-3", provider: "xai" },
      models: [{ id: "grok-3", provider: "xai" }, { id: "grok-4", provider: "xai" }],
    });
    expect(store.getState().currentModel?.id).toBe("grok-3");
  });

  it("applies branches.list into the branch picker's fields (#466)", () => {
    const store = new SessionStore();
    store.setDraftRepo("bivysh/bivy");
    store.setBranchesLoading(true);
    expect(store.getState().branchesLoading).toBe(true);
    store.apply({
      type: "branches.list",
      repo: "bivysh/bivy",
      branches: [{ name: "main" }, { name: "feature/x" }],
      defaultBranch: "main",
    });
    const s = store.getState();
    expect(s.branchesLoading).toBe(false);
    expect(s.branchesRepo).toBe("bivysh/bivy");
    expect(s.branchesDefault).toBe("main");
    expect(s.branches.map((b) => b.name)).toEqual(["main", "feature/x"]);
  });

  it("surfaces a branches.list error and tolerates a malformed/missing list", () => {
    const store = new SessionStore();
    store.apply({ type: "branches.list", repo: "bivysh/bivy", error: "GitHub responded 404" });
    expect(store.getState().branches).toEqual([]);
    expect(store.getState().branchesError).toBe("GitHub responded 404");
    // No `branches` array at all (an older/odd payload) → empty list, not a throw.
    store.apply({ type: "branches.list", repo: "bivysh/bivy" } as never);
    expect(store.getState().branches).toEqual([]);
  });

  it("clearBranches resets the branch list AND the picked branch (repo changed)", () => {
    const store = new SessionStore();
    store.setDraftBranch("feature/x");
    store.apply({ type: "branches.list", repo: "bivysh/bivy", branches: [{ name: "feature/x" }], defaultBranch: "main" });
    expect(store.getState().draft.branch).toBe("feature/x");
    expect(store.getState().branches.length).toBe(1);

    // Picking a different repo must drop the previous repo's branch pick and
    // list — a branch chosen on repo A means nothing once the draft moves to
    // repo B (the regression this guards: a stale pick silently basing the new
    // repo's clone off a branch name that belongs to someone else's repo).
    store.clearBranches();
    const s = store.getState();
    expect(s.draft.branch).toBeNull();
    expect(s.branches).toEqual([]);
    expect(s.branchesRepo).toBeNull();
    expect(s.branchesDefault).toBeNull();
  });

  it("tracks paused sessions and folds a PR result into github context", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.paused", sessionId: "s1" });
    expect(store.getState().pausedSessionIds).toContain("s1");
    store.apply({ type: "session.resumed", sessionId: "s1" });
    expect(store.getState().pausedSessionIds).not.toContain("s1");
    store.apply({ type: "session.pr_result", sessionId: "s1", ok: true, prUrl: "https://github.com/a/b/pull/3" });
    expect(store.getState().prResult?.url).toBe("https://github.com/a/b/pull/3");
    expect(store.getState().github.prUrl).toBe("https://github.com/a/b/pull/3");
    store.clearPrResult();
    expect(store.getState().prResult).toBeNull();
  });

  it("session.pr_opened folds a multi-PR list onto both the row and the active pill", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    const prs = [
      { url: "https://github.com/a/b/pull/4", number: 4, state: "open" },
      { url: "https://github.com/a/b/pull/2", number: 2, state: "merged" },
    ];
    store.apply({ type: "session.pr_opened", sessionId: "s1", prUrl: "https://github.com/a/b/pull/4", prs });
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row?.prs).toHaveLength(2);
    expect(row?.prUrl).toBe("https://github.com/a/b/pull/4");
    expect(store.getState().github.prs).toHaveLength(2);
    expect(store.getState().github.prUrl).toBe("https://github.com/a/b/pull/4");
  });

  it("a PR merging (no open PR left) clears the open prUrl but keeps the merged PR in the list", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.pr_opened", sessionId: "s1", prUrl: "https://github.com/a/b/pull/4", prs: [{ url: "https://github.com/a/b/pull/4", state: "open" }] });
    expect(store.getState().github.prUrl).toBe("https://github.com/a/b/pull/4");
    // Later refresh: the PR merged, so there's no open PR and prUrl is absent.
    store.apply({ type: "session.pr_opened", sessionId: "s1", prs: [{ url: "https://github.com/a/b/pull/4", state: "merged" }] });
    expect(store.getState().github.prUrl).toBeNull();
    expect(store.getState().github.prs[0].state).toBe("merged");
    expect(store.getState().sessions[0].prUrl).toBeUndefined();
  });

  it("synthesizes a PR list from a bare prUrl (older node without a prs field)", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One", prUrl: "https://github.com/a/b/pull/7" }] });
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row?.prs).toEqual([{ url: "https://github.com/a/b/pull/7", state: "open" }]);
  });

  it("tracks pending approvals and clears them on resolve", () => {
    const store = new SessionStore();
    store.apply({ type: "approval.created", approval: { id: "a1", tool: "bash", summary: "rm -rf" } });
    expect(store.getState().approvals).toHaveLength(1);
    store.apply({ type: "approval.resolved", id: "a1" });
    expect(store.getState().approvals).toHaveLength(0);
  });

  it("tracks a pending clarifying question, lights the sidebar dot, and clears both on resolve", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({
      type: "session.question",
      sessionId: "s1",
      requestId: "q1",
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    });
    expect(store.getState().questions).toHaveLength(1);
    expect(store.getState().questions[0]!.sessionId).toBe("s1");
    expect(store.getState().sessions[0]!.needsAction).toBe(true);
    expect(store.getState().sessions[0]!.status).toBe("needs_action");
    store.apply({ type: "session.question.resolved", sessionId: "s1", requestId: "q1" });
    expect(store.getState().questions).toHaveLength(0);
    expect(store.getState().sessions[0]!.needsAction).toBe(false);
    expect(store.getState().sessions[0]!.status).toBe("idle");
  });

  it("keeps the sidebar needs-action dot lit while either an approval or a question is still pending on that session", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    store.apply({ type: "approval.created", approval: { id: "a1", sessionId: "s1", tool: "bash" } });
    store.apply({
      type: "session.question",
      sessionId: "s1",
      requestId: "q1",
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    });
    store.apply({ type: "approval.resolved", id: "a1" });
    // The question is still pending — resolving the approval alone must not
    // clear the dot out from under it.
    expect(store.getState().sessions[0]!.needsAction).toBe(true);
    store.apply({ type: "session.question.resolved", sessionId: "s1", requestId: "q1" });
    expect(store.getState().sessions[0]!.needsAction).toBe(false);
  });

  it("a session.question's needs_action survives the node's generic session.event re-broadcast of the same user_question", () => {
    // The node broadcasts every user_question twice: once as the dedicated
    // session.question (asserted above), and again wrapped in the generic
    // session.event forward-everything-for-debugging envelope (since it's
    // also a RuntimeEvent). The generic envelope's own handler used to treat
    // any non-agent_end inner event as "the agent is working", clobbering the
    // needs_action this dedicated event had just set moments earlier.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ id: "s1", name: "One" }] });
    const questions = [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
    store.apply({ type: "session.question", sessionId: "s1", requestId: "q1", questions });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "user_question", requestId: "q1", questions } });
    expect(store.getState().sessions[0]!.needsAction).toBe(true);
    expect(store.getState().sessions[0]!.status).toBe("needs_action");
    // Same for the resolution side: the generic envelope's re-broadcast must
    // not flip it back to "working" between the dedicated resolved event and
    // whatever comes next.
    store.apply({ type: "session.question.resolved", sessionId: "s1", requestId: "q1" });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "user_question_resolved", requestId: "q1" } });
    expect(store.getState().sessions[0]!.needsAction).toBe(false);
    expect(store.getState().sessions[0]!.status).toBe("idle");
  });

  it("ignores a session.error broadcast for a different, non-active session", () => {
    // Regression: the node broadcasts session.error to every connected client
    // (e.g. a stale model.select against a background session). Without a
    // sessionId guard, that error used to blow away the *active* session's
    // working state and surface as if the visible session had crashed.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "agent_start" });
    expect(store.getState().working).toBe(true);
    store.apply({ type: "session.error", sessionId: "s2", error: "boom" });
    expect(store.getState().working).toBe(true);
    expect(store.getState().error).toBeNull();
    expect(store.getState().transcript.some((e) => e.role === "error")).toBe(false);
    // An error naming the active session now lands *inline in that chat* as an
    // error entry (not the floating toast) and still clears the working spinner.
    store.apply({ type: "session.error", sessionId: "s1", error: "boom" });
    expect(store.getState().working).toBe(false);
    expect(store.getState().error).toBeNull();
    const errorEntry = store.getState().transcript.find((e) => e.role === "error");
    expect(errorEntry?.text).toBe("boom");
  });

  it("renders a session-less error as the global toast, not inline", () => {
    // Connection/relay/global failures have no sessionId — they aren't about any
    // one chat, so they stay in the toast rather than polluting the transcript.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.error", error: "relay down" });
    expect(store.getState().error).toBe("relay down");
    expect(store.getState().transcript.some((e) => e.role === "error")).toBe(false);
  });

  it("rebuilds a persisted error turn as an inline error on reload", () => {
    // A turn the provider failed is saved as an assistant message with
    // stopReason "error" + errorMessage (often empty content). Reloading history
    // must show it, not a blank turn — the "looks done, no reply" gap.
    const store = new SessionStore();
    store.apply({
      type: "session.history",
      requestId: "r1",
      sessionId: "s1",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [], stopReason: "error", errorMessage: "Credit balance is too low." },
      ],
    });
    const errorEntry = store.getState().transcript.find((e) => e.role === "error");
    expect(errorEntry?.text).toBe("Credit balance is too low.");
  });

  it("renders a runtime session.error wrapped in session.event inline in that chat", () => {
    // CLI adapters (e.g. Codex credential preflight) emit a bare session.error
    // with no sessionId; the node wraps it in a session.event envelope that
    // carries the sessionId. The envelope's id must flow onto the inner error so
    // it lands in the chat, not the global toast.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.event", sessionId: "s1", event: { type: "session.error", error: "Codex has no OpenAI credential on this node." } });
    expect(store.getState().error).toBeNull();
    const errorEntry = store.getState().transcript.find((e) => e.role === "error");
    expect(errorEntry?.text).toBe("Codex has no OpenAI credential on this node.");
  });

  it("humanizes a provider JSON error into the inline message", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({
      type: "session.error",
      sessionId: "s1",
      error: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Add more usage and keep going."}}',
    });
    const errorEntry = store.getState().transcript.find((e) => e.role === "error");
    expect(errorEntry?.text).toBe("Add more usage and keep going.");
  });

  it("calls onSessionSettled once a turn finishes, so the sidebar can refresh", () => {
    // Regression: a freshly created session's one-shot sidebar refresh could
    // race the node still naming/persisting it. onSessionSettled is a
    // self-healing backstop the controller wires to re-pull the session list.
    const store = new SessionStore();
    const onSettled = vi.fn();
    store.onSessionSettled = onSettled;
    store.apply({ type: "agent_start" });
    expect(onSettled).not.toHaveBeenCalled();
    store.apply({ type: "agent_end" });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("calls onSessionCreatedElsewhere on a session.created broadcast, so the sidebar can converge immediately", () => {
    // Regression: the node broadcasts session.created for any client that
    // creates a session (this one, or the CLI/TUI, or another device) — the
    // store used to have no case for it at all, so the sidebar only ever
    // learned about a fresh session via the one-shot post-session.new refresh
    // or the next agent_end, both of which can be arbitrarily delayed.
    const store = new SessionStore();
    const onCreated = vi.fn();
    store.onSessionCreatedElsewhere = onCreated;
    store.apply({ type: "session.created", sessionId: "s1" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("upserts a session.created row into the sidebar without stealing focus", () => {
    // A session started anywhere (CLI/TUI, another device, or our own
    // session.new) must show in the sidebar immediately, ahead of the
    // authoritative sessions.list re-pull, and must not change the active view.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "open", messages: [], name: "Open one" });
    store.apply({ type: "session.created", sessionId: "cli", name: "From CLI", sessionFile: "/p/cli.json" });
    const state = store.getState();
    expect(state.activeSessionId).toBe("open"); // focus unchanged
    const row = state.sessions.find((s) => s.sessionId === "cli");
    expect(row).toBeTruthy();
    expect(row!.name).toBe("From CLI");
    expect(row!.path).toBe("/p/cli.json");
  });

  it("defaults a freshly created session's updatedAt to now, not undefined", () => {
    // Regression: a brand-new session had no node-side modified time yet, so
    // its sidebar row's updatedAt stayed undefined — SessionList's toMs()
    // treats that as 0, sorting the just-created (and thus most recent)
    // session dead last instead of first, until the next full sessions.list
    // refresh happened to catch up.
    const store = new SessionStore();
    store.apply({ type: "session.created", sessionId: "s1", name: "New one" });
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row!.updatedAt).toBeGreaterThan(0);
  });

  it("bumps a session row's updatedAt when a turn actually finishes (agent_end)", () => {
    // Regression: nothing ever refreshed a sidebar row's updatedAt as a
    // session kept being used — it was set once at creation and never again,
    // so an actively-worked-on session could sit stuck below older, inactive
    // ones until the next 25s sidebar poll happened to catch up.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One", updatedAt: 100 }] });
    store.apply({
      type: "session.event",
      sessionId: "s1",
      event: { type: "agent_end" },
    });
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row!.updatedAt).toBeGreaterThan(100);
  });

  it("does NOT bump a session row's updatedAt on interim tool/message activity (#479)", () => {
    // Multiple agents streaming tool calls and message deltas at once must not
    // reorder the sidebar on every one of them — only a turn actually finishing,
    // needing input, or a fresh user message should move a row. Otherwise the
    // list keeps jumping under the user's cursor while several sessions work.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One", updatedAt: 100 }] });
    for (const type of ["agent_start", "turn_start", "message_start", "message_update", "tool_call", "tool_result", "turn_end"]) {
      store.apply({ type: "session.event", sessionId: "s1", event: { type } });
    }
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row!.updatedAt).toBe(100);
    // The status dot still reflects the live activity — only ordering is held back.
    expect(row!.status).toBe("working");
  });

  it("bumps updatedAt when a session needs the user's input (approval or clarifying question)", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [
        { id: "s1", name: "One", updatedAt: 100 },
        { id: "s2", name: "Two", updatedAt: 100 },
      ],
    });
    store.apply({ type: "approval.created", approval: { id: "a1", sessionId: "s1", tool: "bash" } });
    store.apply({ type: "session.question", sessionId: "s2", requestId: "q1", questions: [{ question: "Which?", header: "h", options: [{ label: "a" }, { label: "b" }] }] });
    const s1 = store.getState().sessions.find((s) => s.sessionId === "s1");
    const s2 = store.getState().sessions.find((s) => s.sessionId === "s2");
    expect(s1!.updatedAt).toBeGreaterThan(100);
    expect(s2!.updatedAt).toBeGreaterThan(100);
  });

  it("bumps a session row's updatedAt as soon as a message is sent, before any server round trip", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One", updatedAt: 100 }] });
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.addUserMessage("go", "cm-1");
    const row = store.getState().sessions.find((s) => s.sessionId === "s1");
    expect(row!.updatedAt).toBeGreaterThan(100);
  });

  it("adopts the node-assigned name on session.renamed (list row + active title)", () => {
    // The node names a session from its first message via maybeNameSession and
    // broadcasts session.renamed; the sidebar/title only learn the real name here.
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "Session abc12345" }] });
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [], name: "Session abc12345" });
    store.apply({ type: "session.renamed", sessionId: "s1", name: "Fix the parser" });
    const state = store.getState();
    expect(state.activeTitle).toBe("Fix the parser");
    expect(state.sessions.find((s) => s.sessionId === "s1")!.name).toBe("Fix the parser");
  });

  it("drops the row and clears the view on session.deleted for the active session", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One" }, { sessionId: "s2", name: "Two" }] });
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
    store.apply({ type: "session.deleted", sessionId: "s1" });
    const state = store.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(state.activeSessionId).toBeNull();
    expect(state.transcript).toEqual([]);
  });

  it("marks a session saved but keeps the active view on session.closed", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "One" }] });
    // Actually focus s1 first. A bare session.history (no requestId, no open) is
    // never adopted while activeSessionId is null — see applyHistory's adopt
    // guard — so without beginOpen the session was never on screen and the
    // "keeps the active view" assertion below couldn't be exercised.
    store.beginOpen("s1");
    store.apply({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
    store.apply({ type: "session.closed", sessionId: "s1" });
    const state = store.getState();
    expect(state.sessions.find((s) => s.sessionId === "s1")!.status).toBe("saved");
    expect(state.activeSessionId).toBe("s1");
    expect(state.transcript.map((e) => e.text)).toEqual(["hi"]);
    expect(state.working).toBe(false);
  });

  it("shows a working label while a repo session clones (session.cloning)", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({ type: "session.cloning", sessionId: "s1", repo: "owner/repo" });
    expect(store.getState().working).toBe(true);
    expect(store.getState().workingLabel).toBe("Cloning owner/repo…");
  });

  it("clears the agent pill when starting a fresh draft, instead of keeping the previous session's agent", () => {
    // Regression: opening a Pi session set currentAgentName/selectedAgentId to
    // Pi, and resetActiveSession() (the "+ New" flow) never touched either
    // field — so a brand-new draft's composer kept showing "Pi" even though
    // the session it was about to create had nothing to do with that agent,
    // only correcting itself once the real session.history reported the
    // actual agent used for the new session.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [], agentName: "Pi" });
    expect(store.getState().currentAgentName).toBe("Pi");
    store.resetActiveSession();
    expect(store.getState().currentAgentName).toBe("");
    expect(store.getState().selectedAgentId).toBeNull();
  });

  it("clears the previous session's usage/changes/checkpoints when starting a fresh draft", () => {
    // Regression: resetActiveSession() (the "+ New" flow) cleared the transcript
    // and agent pill but left `usage` (and changes/checkpoints) untouched — so a
    // brand-new session showed the previously viewed session's cost/token usage
    // bar (e.g. "$6.98 · 6,895,052 tokens") before it had done anything at all.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({
      type: "session.usage",
      sessionId: "s1",
      usage: { costUsd: 6.9832, tokens: { total: 6_895_052 } },
    });
    expect(store.getState().usage?.tokens?.total).toBe(6_895_052);
    store.resetActiveSession();
    expect(store.getState().usage).toBeNull();
    expect(store.getState().changes).toBeNull();
    expect(store.getState().checkpoints).toEqual([]);
  });

  it("ignores a previous session's late chrome events while on a fresh draft", () => {
    // Regression: after "+ New" (activeSessionId === null), a late broadcast from
    // the session the user just left — session.changes / session.usage /
    // session.checkpoints — leaked its "files changed this turn" card, usage bar
    // and history onto the brand-new empty draft. The old guard
    // (`sessionId && activeSessionId && sessionId !== activeSessionId`) skipped
    // the filter entirely while activeSessionId was null, so any concrete
    // sessionId slipped through. A draft matches no concrete session, so these
    // must be dropped.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.resetActiveSession();
    expect(store.getState().activeSessionId).toBeNull();

    store.apply({
      type: "session.changes",
      sessionId: "s1",
      before: "cp0",
      after: "cp1",
      changes: [{ path: "a.ts", status: "modified", oldText: "x", newText: "y" }],
    });
    store.apply({ type: "session.usage", sessionId: "s1", usage: { costUsd: 1, tokens: { total: 100 } } });
    store.apply({ type: "session.checkpoints", sessionId: "s1", checkpoints: [{ id: "cp0", label: "start", createdAt: 1 }] });

    expect(store.getState().changes).toBeNull();
    expect(store.getState().usage).toBeNull();
    expect(store.getState().checkpoints).toEqual([]);
  });

  it("still applies chrome events that belong to the focused session", () => {
    // The stricter foreign-session filter must not drop events for the session
    // actually on screen.
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [] });
    store.apply({
      type: "session.changes",
      sessionId: "s1",
      before: "cp0",
      after: "cp1",
      changes: [{ path: "a.ts", status: "modified", oldText: "x", newText: "y" }],
    });
    expect(store.getState().changes?.files.length).toBe(1);
  });

  it("seeds a fresh draft's agent + model pills from the known lists (no bare Agent/Default flash)", () => {
    // Regression (new-message flow): a fresh draft blanked the agent pill and
    // could sit on "Agent"/"Default" until the runtimes.list/models.list
    // round-trips answered. seedDraftAgentModel paints the real agent + model
    // immediately from the lists the connect-time burst already loaded.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "claude", displayName: "Claude Code" },
      runtimes: [
        { id: "claude", displayName: "Claude Code", current: true },
        { id: "pi", displayName: "Pi" },
      ],
    });
    store.apply({
      type: "models.list",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    // Start a fresh draft — the pill is blanked here…
    store.resetActiveSession();
    expect(store.getState().currentAgentName).toBe("");
    // …then eagerly re-seeded from the last-used pick before any round-trip.
    store.seedDraftAgentModel("pi", { provider: "anthropic", id: "opus" });
    expect(store.getState().selectedAgentId).toBe("pi");
    expect(store.getState().currentAgentName).toBe("Pi");
    expect(store.getState().currentModel?.id).toBe("opus");
  });

  it("falls back to the node's default agent + model when nothing is remembered", () => {
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "claude", displayName: "Claude Code" },
      runtimes: [
        { id: "claude", displayName: "Claude Code", current: true },
        { id: "pi", displayName: "Pi" },
      ],
    });
    store.apply({
      type: "models.list",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    store.resetActiveSession();
    store.seedDraftAgentModel(null, null);
    expect(store.getState().currentAgentName).toBe("Claude Code");
    expect(store.getState().currentModel?.id).toBe("sonnet");
  });

  it("never overrides a live session's agent/model when seeding a draft", () => {
    const store = new SessionStore();
    store.apply({ type: "session.history", requestId: "r1", sessionId: "s1", messages: [], agentName: "Pi" });
    expect(store.getState().activeSessionId).toBe("s1");
    store.seedDraftAgentModel("claude", { provider: "anthropic", id: "opus" });
    // A session is active — the seed must be a no-op.
    expect(store.getState().currentAgentName).toBe("Pi");
  });

  it("prefers the node's actual default runtime over the leaky node-global `active` session's agent", () => {
    // Regression (the "agent-switching bug", see src/server.ts's comment on
    // sessionForModelQuery): runtimes.list's `activeAgent` mirrors whatever the
    // node-global `active` session happens to be running — a legacy,
    // single-session concept unrelated to what a *new* session will start
    // with — while `current` is the node's real default runtime. The store
    // used to prefer `activeAgent`, so opening the agent picker (or any
    // runtimes.list refresh) for a fresh draft could pin the composer's pill
    // to an unrelated session's agent.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "claude", displayName: "Claude Code" },
      activeAgent: "pi",
      runtimes: [
        { id: "claude", displayName: "Claude Code" },
        { id: "pi", displayName: "Pi" },
      ],
    });
    const state = store.getState();
    expect(state.selectedAgentId).toBe("claude");
    expect(state.currentAgentName).toBe("Claude Code");
  });

  it("does not seed a draft model from a list that belongs to a different agent", () => {
    // Regression ("Claude shows Codex models"): a models.list resolved for one
    // agent (Codex → GPT models) lingered in state after the user switched
    // agents, and seedDraftAgentModel happily painted the *new* agent's (Claude)
    // model pill from those stale, wrong-agent models. The node now tags each
    // list with its runtimeId; seeding a different agent must drop the stale list
    // instead of adopting it, leaving the model blank until the new agent's
    // models.list refresh lands.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "codex", displayName: "Codex", current: true },
      runtimes: [
        { id: "codex", displayName: "Codex", current: true },
        { id: "claude", displayName: "Claude Code" },
      ],
    });
    // A Codex models list is applied and tagged with its runtime.
    store.apply({
      type: "models.list",
      runtimeId: "codex",
      current: { id: "gpt-5", provider: "openai" },
      models: [{ id: "gpt-5", provider: "openai", current: true }],
    });
    expect(store.getState().modelsRuntimeId).toBe("codex");
    expect(store.getState().currentModel?.id).toBe("gpt-5");

    // The user starts a fresh draft preferring Claude — the stale Codex model
    // must not carry over onto Claude's pill.
    store.resetActiveSession();
    store.seedDraftAgentModel("claude", null);
    expect(store.getState().selectedAgentId).toBe("claude");
    expect(store.getState().currentModel).toBeNull();
    expect(store.getState().models).toEqual([]);

    // Claude's own models.list refresh then repopulates the pill correctly.
    store.apply({
      type: "models.list",
      runtimeId: "claude",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    expect(store.getState().modelsRuntimeId).toBe("claude");
    expect(store.getState().currentModel?.id).toBe("sonnet");
  });

  it("still seeds the model when the held list is for the same agent (no flash)", () => {
    // The scoping above must not blank the pill when the cached list already
    // belongs to the agent being seeded — the common case on a second new
    // session, where re-fetching would only flash an empty pill.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "claude", displayName: "Claude Code", current: true },
      runtimes: [{ id: "claude", displayName: "Claude Code", current: true }],
    });
    store.apply({
      type: "models.list",
      runtimeId: "claude",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    store.resetActiveSession();
    store.seedDraftAgentModel("claude", { provider: "anthropic", id: "opus" });
    expect(store.getState().currentModel?.id).toBe("opus");
  });

  it("drops the outgoing agent's models the moment a different agent is picked", () => {
    // Manually switching agents in the picker must not keep the old agent's
    // models (and current model) on the composer/picker until the refresh lands
    // — the same "Claude shows Codex models" bug, via the manual-pick path.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "codex", displayName: "Codex", current: true },
      runtimes: [
        { id: "codex", displayName: "Codex", current: true },
        { id: "claude", displayName: "Claude Code" },
      ],
    });
    store.apply({
      type: "models.list",
      runtimeId: "codex",
      current: { id: "gpt-5", provider: "openai" },
      models: [{ id: "gpt-5", provider: "openai", current: true }],
    });
    store.setSelectedAgentLocal("claude");
    expect(store.getState().selectedAgentId).toBe("claude");
    expect(store.getState().currentModel).toBeNull();
    expect(store.getState().models).toEqual([]);
  });

  it("repaints a previously-viewed agent's models instantly on switch back (per-runtime cache)", () => {
    // Faster model switch (Phase 3): switching back to an agent already listed
    // this session must NOT blank to a loading state — the store repaints that
    // runtime's last-known models immediately while the node's fresh list
    // refreshes in the background.
    const store = new SessionStore();
    store.apply({
      type: "runtimes.list",
      current: { id: "codex", displayName: "Codex", current: true },
      runtimes: [
        { id: "codex", displayName: "Codex", current: true },
        { id: "claude", displayName: "Claude Code" },
      ],
    });
    // View Claude first so its list is cached.
    store.setSelectedAgentLocal("claude");
    store.apply({
      type: "models.list",
      runtimeId: "claude",
      current: { id: "sonnet", provider: "anthropic" },
      models: [{ id: "opus", provider: "anthropic" }, { id: "sonnet", provider: "anthropic" }],
    });
    // Switch to Codex (never viewed) → blanks, as before.
    store.setSelectedAgentLocal("codex");
    expect(store.getState().models).toEqual([]);
    expect(store.getState().currentModel).toBeNull();
    store.apply({
      type: "models.list",
      runtimeId: "codex",
      current: { id: "gpt-5", provider: "openai" },
      models: [{ id: "gpt-5", provider: "openai", current: true }],
    });
    // Switch back to Claude → its cached list repaints at once (no blank), with
    // the runtime tag flipped and the remembered current model restored.
    store.setSelectedAgentLocal("claude");
    expect(store.getState().modelsRuntimeId).toBe("claude");
    expect(store.getState().models.map((m) => m.id)).toEqual(["opus", "sonnet"]);
    expect(store.getState().currentModel?.id).toBe("sonnet");
  });
});

describe("session.auth_required → sign-in prompt", () => {
  function focusedStore(): SessionStore {
    const store = new SessionStore();
    store.setCurrentNode("node-1");
    store.beginOpen("s1");
    return store;
  }

  it("raises needsModelAuth targeted at the failing provider", () => {
    const store = focusedStore();
    store.apply({ type: "session.auth_required", sessionId: "s1", provider: "openai-codex", reason: "401 Unauthorized" } as never);
    expect(store.getState().needsModelAuth).toEqual({ nodeId: "node-1", provider: "openai-codex", reason: "401 Unauthorized" });
  });

  it("ignores an auth_required for a background (non-active) session", () => {
    const store = focusedStore();
    store.apply({ type: "session.auth_required", sessionId: "other", provider: "openai-codex" } as never);
    expect(store.getState().needsModelAuth).toBeNull();
  });

  it("does not dismiss a targeted prompt when a DIFFERENT provider connects", () => {
    const store = focusedStore();
    store.apply({ type: "session.auth_required", sessionId: "s1", provider: "openai-codex" } as never);
    // Anthropic connecting must not satisfy an openai-codex prompt.
    store.apply({ type: "providers.list", providers: [{ id: "anthropic", configured: true }, { id: "openai-codex", configured: false }] } as never);
    expect(store.getState().needsModelAuth?.provider).toBe("openai-codex");
  });

  it("dismisses when the targeted provider connects", () => {
    const store = focusedStore();
    store.apply({ type: "session.auth_required", sessionId: "s1", provider: "openai-codex" } as never);
    store.apply({ type: "providers.list", providers: [{ id: "openai-codex", configured: true }] } as never);
    expect(store.getState().needsModelAuth).toBeNull();
  });

  it("dismisses when the api-key alias (openai) connects for a codex prompt", () => {
    const store = focusedStore();
    store.apply({ type: "session.auth_required", sessionId: "s1", provider: "openai-codex" } as never);
    // A pasted OpenAI key lands under `openai` (OPENAI_API_KEY), which Codex
    // reads — that satisfies the openai-codex prompt too.
    store.apply({ type: "providers.list", providers: [{ id: "openai", configured: true }] } as never);
    expect(store.getState().needsModelAuth).toBeNull();
  });
});
