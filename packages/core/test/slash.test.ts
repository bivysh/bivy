// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import {
  isSlashInput,
  parseSlash,
  matchSlashCommands,
  findSlashCommand,
  slashHelpText,
  resolveSlash,
  isValidAgentCommand,
  agentScopedName,
  SLASH_COMMANDS,
} from "../src/slash.js";

describe("isSlashInput", () => {
  it("recognises a slash command line", () => {
    expect(isSlashInput("/pr")).toBe(true);
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
    expect(parseSlash("/pr")).toEqual({ name: "/pr", args: "" });
    expect(parseSlash("/model claude sonnet")).toEqual({ name: "/model", args: "claude sonnet" });
  });
  it("lower-cases and trims the command word", () => {
    expect(parseSlash("  /PR  ")).toEqual({ name: "/pr", args: "" });
  });
  it("resolves aliases to the canonical name", () => {
    expect(parseSlash("/stop")).toEqual({ name: "/abort", args: "" });
  });
  it("returns an unknown command as typed (so the caller can warn, not run it)", () => {
    expect(parseSlash("/nope now")).toEqual({ name: "/nope", args: "now" });
    expect(findSlashCommand("/nope")).toBeUndefined();
  });
  it("returns null for non-slash input", () => {
    expect(parseSlash("just a prompt")).toBeNull();
  });
  it("recognises the /agent:<name> escape hatch (scoped, no alias resolution)", () => {
    expect(parseSlash("/agent:model sonnet")).toEqual({ name: "/model", args: "sonnet", agentScoped: true });
    // The scoped name is taken literally — "/agent:stop" targets the agent's own
    // "/stop", not Bivy's "/abort" alias.
    expect(parseSlash("/agent:stop")).toEqual({ name: "/stop", args: "", agentScoped: true });
  });
  it("leaves the bare /agent Bivy command unscoped (no colon)", () => {
    expect(parseSlash("/agent")).toEqual({ name: "/agent", args: "" });
    expect(parseSlash("/agent claude")).toEqual({ name: "/agent", args: "claude" });
  });
});

describe("matchSlashCommands", () => {
  it("returns all commands for a bare slash", () => {
    expect(matchSlashCommands("/")).toHaveLength(SLASH_COMMANDS.length);
  });
  it("filters by prefix on names and aliases", () => {
    expect(matchSlashCommands("/pr").map((c) => c.name)).toEqual(["/pr"]);
    // "/st" matches "/abort" via its "/stop" alias.
    expect(matchSlashCommands("/st").map((c) => c.name)).toEqual(["/abort"]);
  });
  it("stops autocompleting once a space is typed", () => {
    expect(matchSlashCommands("/model ")).toEqual([]);
  });
  it("returns nothing for non-slash prefixes", () => {
    expect(matchSlashCommands("hello")).toEqual([]);
  });

  it("appends the agent's advertised commands after the Bivy commands", () => {
    const extra = [{ name: "/compact", description: "Compact" }];
    const names = matchSlashCommands("/", extra).map((c) => c.name);
    expect(names).toEqual([...SLASH_COMMANDS.map((c) => c.name), "/compact"]);
  });

  it("filters agent commands by prefix too", () => {
    const extra = [
      { name: "/compact", description: "Compact" },
      { name: "/status", description: "Status" },
    ];
    expect(matchSlashCommands("/comp", extra).map((c) => c.name)).toEqual(["/compact"]);
  });

  it("keeps Bivy winning a collision but re-surfaces the agent command under /agent:<name>", () => {
    const extra = [{ name: "/model", description: "agent's own model command" }];
    // Typing "/model" only offers Bivy's own — the agent's colliding command is
    // NOT shown under the bare name.
    const models = matchSlashCommands("/model", extra);
    expect(models).toHaveLength(1);
    expect(models[0]?.description).not.toContain("agent's own");
    // …but it's discoverable through the escape-hatch spelling under "/".
    const all = matchSlashCommands("/", extra).map((c) => c.name);
    expect(all).toContain("/agent:model");
  });

  it("filters escape-hatch entries by the /agent: prefix", () => {
    const extra = [
      { name: "/model", description: "agent model" },
      { name: "/compact", description: "compact" },
    ];
    // "/agent:mo" narrows to the scoped colliding command; the non-colliding
    // "/compact" stays under its own name and isn't scoped.
    expect(matchSlashCommands("/agent:mo", extra).map((c) => c.name)).toEqual(["/agent:model"]);
  });

  it("drops malformed agent commands from the menu (robust to bad handshake data)", () => {
    const extra = [
      { name: "/ok", description: "fine" },
      { name: "bad-no-slash" } as any,
      { name: "/" } as any, // too short
      null as any,
      { description: "no name" } as any,
    ];
    expect(matchSlashCommands("/", extra).map((c) => c.name)).toEqual([...SLASH_COMMANDS.map((c) => c.name), "/ok"]);
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

  it("routes a Bivy control command to the bivy action (wins a collision)", () => {
    const res = resolveSlash(parseSlash("/model sonnet")!, agent);
    expect(res).toEqual({ kind: "bivy", name: "/model", args: "sonnet" });
  });

  it("routes a non-colliding agent command to the agent (prompt mode)", () => {
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

  it("reaches a colliding agent command via the /agent:<name> escape hatch", () => {
    const res = resolveSlash(parseSlash("/agent:model gpt-5")!, agent);
    expect(res.kind).toBe("agent");
    if (res.kind === "agent") {
      expect(res.command.description).toBe("agent's own model");
      expect(res.args).toBe("gpt-5");
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

  it("scoped miss is unknown, spelled with the /agent: prefix", () => {
    const res = resolveSlash(parseSlash("/agent:nope")!, agent);
    expect(res).toEqual({ kind: "unknown", name: "/agent:nope", hasCatalog: true });
  });

  it("ignores malformed advertised commands (no catalog if all are junk)", () => {
    const junk = [{ name: "bad" } as any, null as any];
    expect(resolveSlash(parseSlash("/x")!, junk)).toEqual({ kind: "unknown", name: "/x", hasCatalog: false });
  });
});

describe("agentScopedName", () => {
  it("spells the escape-hatch form", () => {
    expect(agentScopedName("/model")).toBe("/agent:model");
    expect(agentScopedName("model")).toBe("/agent:model");
  });
});

describe("findSlashCommand", () => {
  it("looks up by canonical name and alias", () => {
    expect(findSlashCommand("/abort")?.name).toBe("/abort");
    expect(findSlashCommand("/stop")?.name).toBe("/abort");
    expect(findSlashCommand("/unknown")).toBeUndefined();
  });
});

describe("slashHelpText", () => {
  it("lists every Bivy command", () => {
    const help = slashHelpText();
    for (const c of SLASH_COMMANDS) expect(help).toContain(c.name);
    expect(help).toContain("/stop"); // alias surfaced too
  });

  it("includes the active agent's commands under a heading", () => {
    const help = slashHelpText([
      { name: "/compact", description: "Compact the conversation." },
      { name: "/model", description: "agent's own model" }, // collides with Bivy
    ]);
    expect(help).toContain("Agent commands:");
    expect(help).toContain("/compact — Compact the conversation.");
    // The colliding one is listed under its escape-hatch spelling.
    expect(help).toContain("/agent:model — agent's own model");
  });
});
