# Bivy developer platform — implementation plan

**Started:** 2026-08-10
**Status:** Active

## Objective

Turn Bivy's internal extension seams into a stable developer platform while
preserving its core product contract: agents run on infrastructure the user
controls, sensitive session content stays on the node, and every integration
reports its real capabilities and protection level.

Bivy ships integrations, not agents. Every integration must connect to the
upstream agent the operator already installs, authenticates, configures, and uses.
Maintained profiles and bridges use the same contracts as external contributions;
there is no privileged built-in-agent category.

## Product model

Use these terms consistently:

- **Plugin** — an installable, versioned distribution unit.
- **Contribution** — a capability supplied by a plugin.
- **Connection** — configured credentials/account state for a contribution.
- **Agent integration** — discovery and connection metadata for an upstream agent.
- **Agent adapter** — the technical transport Bivy uses to connect to that agent.
- **Tool** — a governed callable operation with an input schema and risk metadata.
- **Skill** — versioned procedural context (for example `SKILL.md`), never an
  executable capability or permission grant.
- **MCP provider** — an upstream or downstream protocol endpoint for tools and
  context; MCP is transport, not the plugin or tool itself.
- **Agent profile** — a user-selectable composition of adapter, model, policy,
  skills, tools, credentials, and compute defaults.
- **Connector** — receives or emits normalized external events.
- **Recipe** — a declarative automation template.

Initial contribution categories:

1. agents and agent profiles;
2. tool providers and skills;
3. triggers and notification sinks;
4. checks and artifacts;
5. compute providers.

## Design rules

1. Prefer ACP for agent control and MCP for tools.
2. Third-party executable code runs out of process, never imported into the node.
3. Manifests are strict, versioned, bounded, and fail closed on unknown fields.
4. Capabilities describe the configured execution path, not the agent's brand.
5. Plugin permissions and execution location are explicit.
6. Node plugins never weaken node or repository safety floors.
7. The hosted control plane does not load arbitrary community code.
8. Bivy-maintained integrations use the same package/registry contract and launch
   the operator's upstream executable rather than a private replacement implementation.
9. Every public contract ships with fixtures and a conformance test.
10. A marketplace comes after version locking, provenance, permissions, and
    compatibility diagnostics.

## Phase 1 — declarative agent plugins

**Status:** Implemented in this branch.

**Goal:** an external developer can add an agent to Bivy without changing this
repository or loading code into the daemon.

### Scope

- [x] Define the alpha `bivy.sh/v1alpha1` plugin manifest.
- [x] Support agent contributions using either:
  - a headless process adapter; or
  - an ACP adapter.
- [x] Validate identifiers, commands, argument bounds, parser identifiers,
  resume templates, model metadata, and unknown fields.
- [x] Add a node-local plugin store under `<data-dir>/plugins` with atomic
  install/remove operations.
- [x] Add `bivy plugin validate|install|list|remove` and JSON output where useful.
- [x] Merge installed agent contributions into the existing runtime catalog.
- [x] Mark external agents Experimental and Unverified; never inherit another
  package's certification.
- [x] Surface manifest/source diagnostics without preventing other integrations
  from starting when one installed plugin is invalid.
- [x] Add parser/store/runtime/CLI tests.
- [x] Document authoring, installation, trust, and current limitations.

### Non-goals

- Downloading packages from a public registry.
- Executing plugin install scripts.
- Arbitrary JavaScript/TypeScript hooks.
- Tool, trigger, UI, compute, or control-plane plugins.
- Promoting plugin agents to Supported without Bivy release certification.

### Exit criteria

- A fixture ACP agent can be installed from one manifest, appears in
  `bivy agents` and the web runtime catalog after restart, and launches through
  the existing governed protocol path.
- A process agent can declare headless args, structured output, resume, and model
  metadata without a Bivy source edit.
- Invalid or conflicting plugins fail visibly and do not alter retained integrations.
- The release artifact contains the implementation and documentation references.

## Phase 2 — plugin SDK and universal tools

**Goal:** make the contracts pleasant to build against and make a connected tool
available consistently across agent adapters.

- [x] Route packaged and node-configured agent integrations through one lifecycle
  for aliases, provenance, visibility, discovery, connection, conflicts, and
  allowlisted upstream installation.
- [x] Add `bivy agent add|list|remove` as a convenience layer over the same strict
  manifest/store contract for user-owned ACP and process agents.
- [x] Extract maintained process profiles and richer Pi/Claude/Codex bridges
  under `src/agents/`; the registry and daemon contain no built-in-agent branch.
- [x] Add a publishable `@bivy/plugin-sdk` workspace package with canonical
  manifest types, validation helpers, executable diagnostics, and JSON Schema.
- [ ] Publish the SDK and add protocol clients/fixtures to its public contract.
- [x] Add `bivy plugin init|test|doctor` with bounded ACP conformance.
- [ ] Add `bivy plugin dev|pack`.
- [x] Define and enforce `requires.bivy` compatibility ranges.
- [ ] Define a plugin lockfile.
- [ ] Add provenance/signature metadata and Official/Verified/Community/Local
  trust tiers.
- [ ] Define canonical Tool and Skill contracts; treat MCP and `SKILL.md` as
  adapters rather than competing extension systems.
- [ ] Make the node tool broker authoritative for both upstream MCP providers and
  downstream agent access.
- [ ] Expose brokered tools through MCP for adapters that cannot consume the
  in-process `ToolProvider` interface.
- [ ] Split tool connections from inbound automation connectors in product
  naming and APIs.
- [ ] Add declarative OAuth/API-key configuration and per-tool risk metadata.

## Phase 3 — connectors, checks, and artifacts

**Goal:** external systems can create work and contribute deterministic evidence
without adding provider branches throughout Bivy.

- [ ] Define a normalized, CloudEvents-style trigger envelope.
- [ ] Add external signed-webhook connector templates first.
- [ ] Keep hosted in-process connectors first-party and reviewed.
- [ ] Add check providers with bounded execution and privacy-safe evidence.
- [ ] Add artifact providers and declarative client rendering metadata.
- [ ] Add notification sinks.
- [ ] Extend repository policy with plugin allowlists and pinned versions.

## Phase 4 — command/event API and modular node

**Goal:** one stable command/event contract backs CLI, REST, WebSocket, relay,
and SDK clients.

- [ ] Version and runtime-validate commands and events.
- [ ] Generate or derive direct-transport routing from the command registry.
- [ ] Add scoped local API tokens for developer tooling.
- [ ] Extract bounded controllers from `src/server.ts`: sessions, runtimes,
  tools, automations, artifacts, and plugin lifecycle.
- [ ] Split observation events from blocking decision points.
- [ ] Add OpenTelemetry-compatible runtime/plugin traces with redaction.

## Phase 5 — governed multi-agent work

**Goal:** Bivy owns agent collaboration rather than merely observing that one
agent invoked a sub-agent.

1. First-class handoff to another agent profile.
2. Parallel comparison in isolated worktrees with normalized outcome comparison.
3. A Bivy-owned `delegate_task` tool that creates a bounded child session.
4. Parent/child lineage, depth/time/cost limits, and scoped policy.
5. Bounded run graphs with declared artifacts between stages.

A general swarm or visual DAG builder remains out of scope until these primitives
have demonstrated demand and reliability.

## Success measures

- No Bivy source edit is needed to add a conforming external agent.
- Median time from plugin template to a locally validated agent is under 30
  minutes.
- Plugin compatibility failures are diagnosed before a session starts.
- Built-in and external runtime capability claims use the same catalog path.
- Tool and trigger plugins retain Bivy's privacy and policy boundaries.
- Multi-agent runs remain understandable through lineage, artifacts, checks,
  cost, and outcomes rather than transcript inspection.
