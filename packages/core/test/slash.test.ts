// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import {
  isSlashInput,
  parseSlash,
  matchSlashCommands,
  slashHelpText,
  resolveSlash,
  isValidAgentCommand,
} from "../src/slash.js";

describe("isSlashInput", () => {
  it("recognises a slash command line", () => {
    expect(isSlashInput("/compact")).toBe(true);
    expect(isSlashInput("  /model sonnet")).toBe(true);
  });
  it("rejects prose and bare slashes", () => {
    expect(isSlashInput("hello")).toBe(false);
    expect(isSlashInput("/")).toBe(false); // no command letter yet
    expect(isSlashInput("/ 4")).toBe(false);
    expect(isSlashInput("and/or")).toBe(false);
  });
});

describe("parseSlash", () => {
  it("splits the command word from the args", () => {
    expect(parseSlash("/compact")).toEqual({ name: "/compact", args: "" });
    expect(parseSlash("/model claude sonnet")).toEqual({ name: "/model", args: "claude sonnet" });
  });
  it("lower-cases and trims the command word", () => {
    expect(parseSlash("  /Compact  ")).toEqual({ name: "/compact", args: "" });
  });
  it("returns an unknown command as typed (so the caller can warn, not run it)", () => {
    expect(parseSlash("/nope now")).toEqual({ name: "/nope", args: "now" });
  });
  it("returns null for non-slash input", () => {
    expect(parseSlash("just a prompt")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  it("returns nothing without advertised commands", () => {
    expect(matchSlashCommands("/")).toEqual([]);
  });
  it("stops autocompleting once a space is typed", () => {
    expect(matchSlashCommands("/model ", [{ name: "/model" }])).toEqual([]);
  });
  it("returns nothing for non-slash prefixes", () => {
    expect(matchSlashCommands("hello", [{ name: "/compact" }])).toEqual([]);
  });

  it("returns the agent's advertised commands for a bare slash", () => {
    const extra = [{ name: "/compact", description: "Compact" }];
    expect(matchSlashCommands("/", extra).map((c) => c.name)).toEqual(["/compact"]);
  });

  it("filters agent commands by prefix", () => {
    const extra = [
      { name: "/compact", description: "Compact" },
      { name: "/status", description: "Status" },
    ];
    expect(matchSlashCommands("/comp", extra).map((c) => c.name)).toEqual(["/compact"]);
  });

  it("filters by alias too", () => {
    const extra = [{ name: "/compact", aliases: ["/squash"] }];
    expect(matchSlashCommands("/squ", extra).map((c) => c.name)).toEqual(["/compact"]);
  });

  it("drops malformed agent commands from the menu (robust to bad handshake data)", () => {
    const extra = [
      { name: "/ok", description: "fine" },
      { name: "bad-no-slash" } as any,
      { name: "/" } as any, // too short
      null as any,
      { description: "no name" } as any,
    ];
    expect(matchSlashCommands("/", extra).map((c) => c.name)).toEqual(["/ok"]);
  });
});

describe("isValidAgentCommand", () => {
  it("accepts a well-formed command and rejects junk", () => {
    expect(isValidAgentCommand({ name: "/compact" })).toBe(true);
    expect(isValidAgentCommand({ name: "/x", description: "d", mode: "protocol" })).toBe(true);
    expect(isValidAgentCommand({ name: "nope" })).toBe(false);
    expect(isValidAgentCommand({ name: "/" })).toBe(false);
    expect(isValidAgentCommand(null)).toBe(false);
    expect(isValidAgentCommand({})).toBe(false);
  });
});

describe("resolveSlash", () => {
  const agent = [
    { name: "/compact", description: "Compact" },
    { name: "/model", description: "agent's own model" },
    { name: "/deploy", description: "Deploy", mode: "protocol" as const },
  ];

  it("routes an advertised agent command to the agent (prompt mode)", () => {
    const res = resolveSlash(parseSlash("/compact")!, agent);
    expect(res.kind).toBe("agent");
    if (res.kind === "agent") {
      expect(res.command.name).toBe("/compact");
      expect(res.command.mode).toBeUndefined();
    }
  });

  it("carries protocol mode through for a protocol command", () => {
    const res = resolveSlash(parseSlash("/deploy staging")!, agent);
    expect(res.kind).toBe("agent");
    if (res.kind === "agent") {
      expect(res.command.mode).toBe("protocol");
      expect(res.args).toBe("staging");
    }
  });

  it("routes a command that would once have collided straight to the agent now", () => {
    const res = resolveSlash(parseSlash("/model sonnet")!, agent);
    expect(res.kind).toBe("agent");
    if (res.kind === "agent") {
      expect(res.command.description).toBe("agent's own model");
      expect(res.args).toBe("sonnet");
    }
  });

  it("rejects an unknown command as unknown-with-catalog when commands are advertised", () => {
    const res = resolveSlash(parseSlash("/nope now")!, agent);
    expect(res).toEqual({ kind: "unknown", name: "/nope", hasCatalog: true });
  });

  it("reports no catalog when the session advertised nothing (permissive forwarding)", () => {
    const res = resolveSlash(parseSlash("/whatever")!, []);
    expect(res).toEqual({ kind: "unknown", name: "/whatever", hasCatalog: false });
  });

  it("ignores malformed advertised commands (no catalog if all are junk)", () => {
    const junk = [{ name: "bad" } as any, null as any];
    expect(resolveSlash(parseSlash("/x")!, junk)).toEqual({ kind: "unknown", name: "/x", hasCatalog: false });
  });
});

describe("slashHelpText", () => {
  it("reports when the agent advertised no commands", () => {
    expect(slashHelpText()).toContain("No commands available");
  });

  it("lists the active agent's advertised commands", () => {
    const help = slashHelpText([
      { name: "/compact", description: "Compact the conversation." },
      { name: "/status", description: "Show status." },
    ]);
    expect(help).toContain("/compact — Compact the conversation.");
    expect(help).toContain("/status — Show status.");
  });
});
