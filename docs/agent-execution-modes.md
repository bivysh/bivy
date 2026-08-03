# Agent execution modes: PTY, pipes, and protocols

## Summary

Bivy should not use a PTY as the default wrapper for every agent. A PTY is the
right compatibility layer for an interactive native CLI, but it is unnecessary
for headless agents and prevents Bivy from receiving structured events when the
agent can provide them.

The proposed design is capability-driven:

```text
agent protocol / ACP > structured JSON over pipes > plain pipes > PTY
```

The highest applicable mode is selected automatically. PTY remains an explicit,
first-class mode for native TUIs and arbitrary agents.

This is an incremental change, not a replacement of the current runtime model.
Most of the required plumbing already exists.

**Implementation status:** the first slice is implemented. Short-lived server
commands now use ordinary pipes unless explicitly marked `requiresTty`; the
interactive native commands are marked accordingly. Runtime catalogs now expose
an `executionMode`, and the agent picker shows Protocol, Structured, or Chat
pipe where applicable. The remaining phases below describe future expansion,
not prerequisites for the current behavior.

## Current implementation

There are currently three materially different process paths:

### 1. Governed chat runtimes: pipes

`src/runtime/process.ts` (`ProcessRuntime`) starts CLI agents with
`child_process.spawn()` and `stdio: "pipe"`. It supports:

- argv or stdin prompts;
- JSON/JSONL parsers where configured;
- normalized streaming events and transcripts;
- process-group termination (`detached` plus negative-PID kill on POSIX);
- model, thinking, credentials, resume templates, and usage parsing;
- native agent sandbox/effect-level governance.

This is already the appropriate low-overhead path for most headless CLI agents.
The support matrix documents which agents use it and which have structured
parsers or resume support.

`src/runtime/protocol.ts` (`ProtocolRuntime`) also uses ordinary pipes. The
protocol handshake, capability advertisement, model selection, resume, usage,
tool interception, and event forwarding are already implemented. ACP agents are
adapted through `bin/acp-shim.mjs` into this path.

### 2. Native interactive sessions: node-pty

`src/terminal.ts` owns daemon-persistent PTYs through `node-pty`. The server's
`openRunTerminal()` uses this for `bivy run`, shims, and native agent TUIs.
It provides:

- real TTY detection and native rendering;
- input, output, resize, and ANSI preservation;
- shared local/remote attachment;
- scrollback replay (currently a 256 KiB tail);
- output coalescing (currently an 8 ms flush window);
- terminal metadata, activity tracking, and client-size management;
- takeover from a pinned native session into governed chat where supported.

A remote client driving an arbitrary TUI still fundamentally needs this mode.
Removing the PTY would change the agent's behavior and break programs that
require terminal modes, cursor control, passwords, or interactive prompts.

### 3. Short-lived server commands: Python PTY wrapper

`src/server.ts` wraps `MeshCommand` executions in `src/pty-runner.py` via
`wrapWithSystemPty()` in `runNativeCommand()`. This is separate from the
persistent `node-pty` run-terminal path. It exists to make command output behave
like terminal output, but those commands are generally not agent conversations.
This wrapper is the clearest initial candidate for conditional removal: use
ordinary piped stdio for commands that do not require a TTY.

`node-pty` is a runtime dependency because the native terminal path needs it.
Eliminating the Python wrapper would not eliminate `node-pty`.

## Goals

1. Avoid allocating a PTY for agents that support headless or structured mode.
2. Preserve arbitrary-agent compatibility and native TUI behavior.
3. Make the selected mode visible and honest in diagnostics and the UI.
4. Keep governance semantics unchanged: pipes alone do not provide per-tool
   interception; ACP/protocol runtimes can.
5. Make adding a new agent mostly a data/configuration change.
6. Allow operators to override automatic selection for broken or unusual CLI
   versions.

## Non-goals

- Converting every agent into a structured runtime without an agent-supported
  protocol or machine-readable output.
- Making a pipe-backed process remotely behave like a native terminal after it
  has started. TTY-sensitive behavior must be chosen at launch.
- Removing PTYs from `bivy run`, shims, terminal attach, or native TUI takeover.
- Claiming that pipes provide approvals. Plain pipes provide process-boundary
  governance only; ACP and compatible protocol adapters provide tool-level
  governance.

## Proposed model

Add an execution-mode declaration to the agent specification/runtime catalog.
The exact names can change, but the distinction should be explicit:

```ts
type AgentExecutionMode = "protocol" | "structured-pipe" | "pipe" | "pty";

type AgentExecutionSpec = {
  defaultMode: AgentExecutionMode;
  protocol?: { command: string; args: string[]; ... };
  structured?: {
    args: string[];
    parser: string;
    promptMode: "argv" | "stdin";
  };
  pty?: { command: string; args: string[] };
  requiresPty?: boolean;
};
```

In practice this should extend the existing data-driven `CLI_AGENT_SPECS` and
`ProcessRuntimeOptions`, rather than introduce a second agent registry. The
existing fields for `parser`, `promptMode`, resume templates, model flags,
ACP promotion, and capability probing already cover much of this contract.

Selection precedence should be:

1. Explicit request (`--pty`, `--pipe`, or an equivalent API field).
2. Protocol/ACP promotion when enabled and validated.
3. Validated structured-pipe mode.
4. Plain pipe mode.
5. PTY fallback for interactive launches or agents marked `requiresPty`.

A one-shot/headless invocation should never silently become a PTY merely because
it is launched through a shim. The existing shim behavior is a good basis: it
passes non-TTY and one-shot invocations through to the real binary, while
interactive invocations use `bivy run` and a daemon PTY.

## API and UX changes

Expose the selected mode as diagnostic metadata, not as a user-facing promise
that every mode has the same capabilities. For example:

```json
{
  "agent": "gemini",
  "executionMode": "structured-pipe",
  "capabilities": {
    "terminal": false,
    "structuredEvents": true,
    "toolInterception": false,
    "resume": true
  }
}
```

Recommended controls:

- `bivy run --pty <agent>`: force a native terminal.
- `bivy run --pipe <agent>`: reject the launch if the agent requires a TTY,
  rather than silently producing a degraded experience.
- `BIVY_<AGENT>_MODE=auto|pty|pipe|structured|acp`: node-level override.
- A server/API `executionMode` field for non-CLI launches.

The existing terminal list should continue to represent only live PTY-backed
terminals. Pipe-backed sessions remain ordinary governed sessions and should
not appear as attachable terminals.

## Implementation plan

### Phase 1: measure and separate command PTYs (implemented)

1. Add a `requiresTty` field to the `MeshCommand` spawn description, defaulting
   to false.
2. Replace unconditional `wrapWithSystemPty()` with direct `spawn()` and
   separate stdout/stderr pipes by default.
3. Mark `/login`, `/model`, `/terminal`, `/config`, `/list`, and `/update` as
   TTY-required because they launch Pi's interactive/native CLI surface.
4. Preserve command cancellation, exit status, and broadcast event behavior.

This is low risk because it does not touch `TerminalManager` or governed agent
sessions. Resource savings are expected mainly for future noninteractive
commands added to this command registry.

### Phase 2: make agent mode explicit (easy to medium)

1. Add an execution-mode field to the existing CLI agent specification.
2. Derive it from current facts rather than duplicating data:
   - `ProtocolRuntime`/ACP => `protocol`;
   - parser + headless flags => `structured-pipe`;
   - ProcessRuntime without a parser => `pipe`;
   - `bivy run`/shim interactive launch => `pty`.
3. Include the mode in runtime/session diagnostics and logs.
4. Add environment and CLI overrides.
5. Update the support matrix to show execution mode separately from approvals.

This is mostly catalog and plumbing work. The difficult part is defining
honest behavior for agents whose CLI flags vary by installed version; the
existing `BIVY_<ID>_ARGS`, structured opt-in, and capability probing mechanisms
should be reused.

### Phase 3: improve automatic structured selection (medium)

1. Keep unverified parsers opt-in, as today, to avoid losing output when a CLI
   changes its JSON shape.
2. When `BIVY_AGENT_STRUCTURED=1` or a validated agent spec is present, select
   the parser and structured flags automatically.
3. Preserve a raw-output fallback for unknown JSON records.
4. Record parser failures and downgrade only the current run, with a clear
   diagnostic.

This provides lower transport overhead and richer UI output, but requires live
validation per agent/version. It is not purely generic because machine-readable
output formats are agent-specific.

### Phase 4: protocol-first promotion (medium, already partly implemented)

1. Continue promoting ACP-capable agents through `bin/acp-shim.mjs` and
   `ProtocolRuntime`.
2. Make ACP selection part of the same execution-mode resolver instead of a
   separate setting.
3. Advertise the actual protocol capabilities after handshake.
4. Keep pipe and PTY fallbacks when ACP startup or handshake fails.

This is where the largest governance benefit comes from: protocol mode can
provide per-tool approvals, durable session references, structured usage,
model selection, and resume without terminal scraping.

### Phase 5: optional PTY-on-demand (medium to hard, probably unnecessary)

Do not attempt to convert an already-running pipe process into a PTY. Instead,
provide an explicit restart/continue action that opens a new PTY-backed native
session when the agent supports resume. Bivy already has this conceptual path
through native session IDs and terminal takeover; it should be reused rather
than adding a live process transport switch.

## Expected benefits

### Resource usage

- One fewer Python process and select loop for non-TTY server commands.
- No PTY buffers, terminal state, ANSI scrollback, resize handling, or raw frame
  forwarding for pipe-backed sessions.
- Fewer UI and WebSocket updates when structured events replace high-frequency
  TUI redraws.
- Better scaling when many agents run concurrently.

The largest savings will come from avoiding native TUI redraw/output transport,
not from the kernel PTY allocation itself. The agent's own model process,
Node/Python runtime, subprocesses, and network activity are likely to dominate
RSS and CPU for most sessions. We should measure before promising a percentage.

### Product benefits

- Cleaner structured transcripts instead of terminal scraping.
- More reliable tool cards, usage, reasoning, and progress events.
- Better mobile rendering and less bandwidth use.
- More accurate busy/idle state than terminal-output heuristics.
- Honest capability reporting per agent and installed version.
- Faster path for third-party agents that implement ACP or the Bivy protocol.
- Easier policy enforcement: protocol interception is clearer than parsing ANSI.
- Better failure diagnostics because command, mode, parser, and handshake are
  separately observable.

### Operational benefits

- PTY capacity can be bounded independently from governed chat capacity.
- Node health reports can distinguish agent RSS from terminal/transport overhead.
- Operators can force a safe compatibility mode for a problematic CLI version.
- The generic escape hatch remains useful without making every agent pay the
  native-terminal cost.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A CLI behaves differently without a TTY | Mark it `requiresPty`, or allow an explicit override. |
| JSON output changes between versions | Keep structured mode opt-in until validated; retain raw fallback. |
| Pipe mode loses interactive authentication/prompts | Use Bivy credential injection or require PTY for login. |
| Users expect every remote session to have a terminal | Label pipe sessions as chat; keep `bivy run` for terminal access. |
| Protocol handshake fails after process launch | Timeout, terminate the child process group, then use configured fallback. |
| Different modes expose different governance | Surface capabilities; never advertise per-tool approval for plain pipes. |
| More catalog complexity | Extend existing `CLI_AGENT_SPECS`; do not create per-mode registries. |
| PTY savings are smaller than expected | Add subtree metrics and output-rate measurements before/after rollout. |

## Testing and rollout

Add unit tests for mode resolution, explicit overrides, capability reporting, and
fallback. Retain existing PTY tests for resize, scrollback, detach, and takeover.
Add integration coverage for:

- a plain pipe agent;
- a structured JSON agent;
- a protocol/ACP agent;
- an interactive PTY agent;
- a failed structured/protocol launch falling back or failing explicitly;
- cancellation of the complete process group.

Implemented rollout:

1. command PTY selection is conditional via `requiresTty`;
2. execution mode and capabilities are exposed in the runtime catalog;
3. the UI displays Protocol, Structured, or Chat pipe;
4. automatic CLI selection prefers ACP, then structured pipes, then plain pipes;
5. `BIVY_AGENT_MODE=auto|protocol|structured|pipe|pty` and
   `BIVY_<ID>_MODE` provide explicit overrides; unavailable explicit modes fail
   closed.

Remaining rollout work is instrumentation and live validation across installed
agent versions.

Useful metrics include process-tree RSS/CPU, PTY count, output bytes/sec,
transport frames/sec, parser errors, protocol handshake failures, and time to
first visible event. Compare identical prompts and agent versions in each mode.

## Effort estimate

- **Phase 1:** 1–2 days, including tests; low risk.
- **Phase 2:** 2–4 days; mostly data model, resolver, diagnostics, and UI wiring.
- **Phase 3:** 2–5 days per validation batch, depending on agents tested.
- **Phase 4:** 1–3 days to unify existing ACP behavior; individual ACP agents
  may need separate validation.
- **Phase 5:** avoid as a transport-switch feature; use existing resume/takeover
  flows instead.

The implementation remains intentionally small: it reuses the existing process,
protocol, parser, ACP, and terminal abstractions rather than introducing a new
agent framework.

## Recommendation

Keep validating agent versions and add process-tree/output metrics. Do not
remove PTYs from native run-terminals: they are the general compatibility path
and the reason remote users can drive an arbitrary CLI. The strategic target is
protocol or structured pipes for chat, with PTY reserved for interactive terminal
sessions and fallback.
