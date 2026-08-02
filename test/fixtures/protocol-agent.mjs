#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// A shim can seed commands up front via ProtocolRuntimeOptions; set
// FIXTURE_NO_COMMANDS to make this hello omit `commands` so a test can prove a
// seeded list survives a hello that doesn't advertise one.
const advertiseCommands = !process.env.FIXTURE_NO_COMMANDS;
// Advertise a model registry unless suppressed — the host derives modelSelection
// from this list (capabilities.modelSelection stays false to prove that).
const advertiseModels = !process.env.FIXTURE_NO_MODELS;
// Self-advertise resume when asked. Proves a protocol agent can turn on resume
// purely via its hello (no Bivy-side `resumable` option): the host then honors
// session.resume. Off by default so the base test keeps asserting resume === false.
const advertiseResume = !!process.env.FIXTURE_RESUME || process.env.FIXTURE_PROTOCOL_RESUME === '1';
// Issue #154: a shim opts into the client offering "Steer current turn" by
// advertising which streamingBehavior hints it actually honors mid-turn.
// Comma-separated so a test can ask for e.g. "steer" or "steer,followUp";
// unset means the hello omits it entirely (the safe default — see
// capabilitiesFromHello in src/runtime/protocol.ts).
const streamingBehaviors = process.env.FIXTURE_STREAMING_BEHAVIORS
  ? process.env.FIXTURE_STREAMING_BEHAVIORS.split(',').filter(Boolean)
  : undefined;
let selectedModel = 'fixture-small';
send({
  type: 'hello',
  protocol: 'bivy-agent-protocol/0',
  runtime: {
    id: 'fixture-agent',
    name: 'Fixture Agent',
    version: '0.0.0',
    ...(advertiseModels ? {
      models: [
        { id: 'fixture-small', name: 'Fixture Small' },
        { id: 'fixture-large', name: 'Fixture Large', provider: 'fixture', reasoning: true },
        { name: 'no-id-dropped' },
      ],
      currentModel: 'fixture-small',
    } : {}),
  },
  capabilities: {
    chat: true,
    streaming: true,
    abort: true,
    toolInterception: true,
    modelSelection: false,
    resume: advertiseResume,
    ...(streamingBehaviors ? { streamingBehaviors } : {}),
    // Agent-native slash commands surfaced in the composer's autocomplete; the
    // host forwards the raw "/name" line as a prompt when one is invoked. The
    // bogus middle entry is dropped by the host's validation (no leading slash).
    ...(advertiseCommands ? {
      commands: [
        { name: '/compact', description: 'Compact the conversation.' },
        { name: 'not-a-command' },
        { name: '/status', description: 'Show agent status.' },
        // A protocol-mode command: the host invokes it via a dedicated
        // command.invoke message (see below) instead of forwarding a slash prompt.
        { name: '/deploy', description: 'Deploy via the shim.', mode: 'protocol' },
      ],
    } : {}),
  },
});

let pendingTool = null;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'hello.ack') return;
  if (msg.type === 'session.create') {
    // Back-compat: older hosts passed a prior ref as `resume` on session.create.
    // New hosts use the explicit session.resume command below.
    const ref = typeof msg.resume === 'string' && msg.resume ? msg.resume : `fixture:${msg.sessionId}`;
    send({ replyTo: msg.id, ok: true, runtimeSessionRef: ref });
    if (typeof msg.resume === 'string' && msg.resume) send({ type: 'session.resumed', sessionId: msg.sessionId, runtimeSessionRef: ref });
    else send({ type: 'session.started', sessionId: msg.sessionId, runtimeSessionRef: ref });
    // Echo what the host actually injected into this subprocess's env, so a
    // test can prove BIVY_SESSION_ID (issue #290 — `bivy attach` resolves its
    // session from this var) reached the protocol agent. Sent as an
    // unrecognized event type so it rides ProtocolSession's verbatim
    // passthrough (handleEvent's default case in src/runtime/protocol.ts)
    // without needing a dedicated message type.
    send({ type: 'env.info', sessionId: msg.sessionId, bivySessionId: process.env.BIVY_SESSION_ID ?? null });
    return;
  }
  if (msg.type === 'model.set') {
    // Commit the chosen model and acknowledge, so the host's setModel resolves.
    selectedModel = typeof msg.model === 'string' ? msg.model : selectedModel;
    send({ replyTo: msg.id, ok: true, model: selectedModel });
    return;
  }
  if (msg.type === 'session.resume') {
    const ref = msg.runtimeSessionRef || msg.resumeRef || msg.sessionId;
    send({ replyTo: msg.id, ok: true, runtimeSessionRef: ref });
    send({ type: 'session.resumed', sessionId: msg.sessionId, runtimeSessionRef: ref });
    return;
  }
  if (msg.type === 'chat.send') {
    send({ replyTo: msg.id, ok: true });
    // Echo what multimodal/steering input actually arrived, so a test can prove
    // the host forwarded image attachments and the streaming hint (verbatim
    // passthrough event — the host re-emits unknown types unchanged).
    send({
      type: 'prompt.received',
      sessionId: msg.sessionId,
      images: Array.isArray(msg.images) ? msg.images.length : 0,
      streamingBehavior: msg.streamingBehavior ?? null,
    });
    send({ type: 'session.status', sessionId: msg.sessionId, status: 'working' });
    // Reasoning stream (surfaced as a thinking sidecar) before the answer text.
    send({ type: 'message.reasoning', sessionId: msg.sessionId, text: `thinking with ${selectedModel}` });
    send({ type: 'message.delta', sessionId: msg.sessionId, role: 'assistant', text: 'hello ' });
    pendingTool = { sessionId: msg.sessionId, toolCallId: 'tc_fixture' };
    send({ type: 'tool.call', sessionId: msg.sessionId, toolCallId: pendingTool.toolCallId, name: 'shell', risk: 'medium', input: { cmd: 'echo ok' } });
    return;
  }
  if (msg.type === 'tool.decision') {
    send({ type: 'tool.result', sessionId: pendingTool?.sessionId || msg.sessionId, toolCallId: msg.toolCallId, status: msg.decision === 'allow' ? 'ok' : 'denied', summary: msg.decision });
    send({ type: 'message.delta', sessionId: pendingTool?.sessionId || msg.sessionId, role: 'assistant', text: 'world' });
    send({ type: 'usage', sessionId: pendingTool?.sessionId || msg.sessionId, usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } });
    send({ type: 'session.status', sessionId: pendingTool?.sessionId || msg.sessionId, status: 'idle' });
    send({ type: 'session.done', sessionId: pendingTool?.sessionId || msg.sessionId });
    return;
  }
  if (msg.type === 'command.invoke') {
    // A protocol-mode agent command. Acknowledge, then echo what arrived so a
    // test can prove the host routed it through invokeCommand()/command.invoke
    // instead of forwarding a slash prompt via chat.send.
    send({ replyTo: msg.id, ok: true });
    send({ type: 'command.invoked', sessionId: msg.sessionId, name: msg.name, args: msg.args ?? '' });
    return;
  }
  if (msg.type === 'session.abort') {
    send({ replyTo: msg.id, ok: true });
    process.exit(0);
  }
});
