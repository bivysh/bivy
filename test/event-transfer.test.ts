import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayConnector } from "../src/remote/relay-client.js";
import { PairingStore } from "../src/device-registry.js";
import { EventTransferStore, MAX_TRANSFER_BYTES, TRANSFER_PAGE_BYTES } from "../src/remote/event-transfer.js";
import { EventTransferReceiver as NodeReceiver } from "../src/remote/event-transfer-receiver.js";
import { EventTransferReceiver, MAX_TRANSFER_BYTES as CLIENT_MAX, TRANSFER_PAGE_BYTES as CLIENT_PAGE } from "../packages/core/src/event-transfer.js";
import { frameMessages } from "../src/relay-chunk.js";
import { createFrameReassembler } from "../packages/core/src/relay-frame.js";
import { sealFrame, openFrame } from "../src/e2e.js";
import type { ServerEvent } from "../packages/core/src/protocol.js";

function wire(event: unknown): ServerEvent {
  const key = randomBytes(32);
  const frames = frameMessages(sealFrame(key, event));
  const receive = createFrameReassembler();
  let result: string | null = null;
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(frame) < 256 * 1024);
    result = receive(JSON.parse(frame));
  }
  assert.ok(result, "each page must independently fit the deployed frame limit");
  return openFrame(key, result).data as ServerEvent;
}

test("history larger than the old limit arrives atomically before live events; a lost page retries", async () => {
  assert.equal(CLIENT_MAX, MAX_TRANSFER_BYTES);
  assert.equal(CLIENT_PAGE, TRANSFER_PAGE_BYTES);
  const store = new EventTransferStore(Date.now, TRANSFER_PAGE_BYTES);
  // One huge UTF-8 message exercises both the total history limit and the
  // single-message case that message-count pagination cannot handle.
  const event = { type: "session.history", sessionId: "s", headSeq: 12, messages: [{ role: "assistant", content: "🛠".repeat(7 * 1024 * 1024) }] };
  assert.throws(() => frameMessages(sealFrame(randomBytes(32), event)), /receiver limit/);
  const output: ServerEvent[] = [];
  let lost = false;
  let reads = 0;
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const receiver = new EventTransferReceiver({
    timeoutMs: 20,
    send: async command => {
      reads++;
      if (!lost) { lost = true; return; }
      queueMicrotask(() => receiver.accept(wire(store.read(command))));
    },
    emit: event => { output.push(event); if (output.length === 2) done(); },
    fault: message => assert.fail(message),
  });
  receiver.accept(wire(store.offer(event)));
  receiver.accept({ type: "session.event", sessionId: "s", seq: 13, event: { type: "agent_end" } });
  assert.equal(output.length, 0, "neither the baseline nor later events may escape mid-transfer");
  await finished;
  assert.deepEqual(output[0], event);
  assert.equal(output[1]?.seq, 13);
  assert.ok(reads > 2);
  receiver.reset();
});

test("a maximum allowed attachment crosses the relay intact", async () => {
  const store = new EventTransferStore(Date.now, TRANSFER_PAGE_BYTES);
  const bytes = Buffer.alloc(25 * 1024 * 1024, 123);
  const event = { type: "attachment.data", requestId: "attachment-request", data: bytes.toString("base64") };
  await new Promise<void>((resolve, reject) => {
    const receiver = new NodeReceiver({
      send: async command => { queueMicrotask(() => receiver.accept(wire(store.read(command)))); },
      emit: result => { try { assert.deepEqual(result, event); resolve(); } catch (error) { reject(error); } },
      fault: reject,
    });
    receiver.accept(wire(store.offer(event)));
  });
});

test("snapshots are immutable, ranges validated, and expired transfers fail explicitly", () => {
  let now = 0;
  const store = new EventTransferStore(() => now, TRANSFER_PAGE_BYTES);
  const event = { type: "session.history", messages: ["x".repeat(TRANSFER_PAGE_BYTES)] };
  const offered = store.offer(event)!;
  const id = (offered.transfer as { id: string }).id;
  event.messages[0] = "changed";
  const first = store.read({ transferId: id, offset: 0 });
  assert.ok(String(first.data).length > 100);
  assert.match(String(store.read({ transferId: id, offset: 1 }).error), /offset/);
  now = 120_001;
  assert.match(String(store.read({ transferId: id, offset: 0 }).error), /expired/);
});

test("corruption never commits partial history or advances the queued live stream", async () => {
  const store = new EventTransferStore(Date.now, TRANSFER_PAGE_BYTES);
  const offer = store.offer({ type: "session.history", messages: ["x".repeat(TRANSFER_PAGE_BYTES)] })!;
  const output: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const receiver = new EventTransferReceiver({
      send: async command => {
        const part = store.read(command);
        const data = Buffer.from(String(part.data), "base64");
        data[0] = data[0]! ^ 1;
        queueMicrotask(() => receiver.accept({ ...part, data: data.toString("base64") } as ServerEvent));
      },
      emit: event => output.push(event),
      fault: message => {
        try { assert.match(message, /integrity/); assert.equal(output.length, 1); assert.equal(output[0]?.type, "session.error"); resolve(); }
        catch (error) { reject(error); }
      },
    });
    receiver.accept(offer as ServerEvent);
    receiver.accept({ type: "session.event", seq: 99 });
  });
});

test("reconnect discards unfinished snapshots and ignores late pages", () => {
  const store = new EventTransferStore(Date.now, TRANSFER_PAGE_BYTES);
  let command: Record<string, unknown> | undefined;
  const output: ServerEvent[] = [];
  const receiver = new EventTransferReceiver({ send: async c => { command = c; }, emit: e => output.push(e), fault: m => assert.fail(m) });
  receiver.accept(store.offer({ type: "session.history", messages: ["x".repeat(TRANSFER_PAGE_BYTES)] }) as ServerEvent);
  receiver.reset();
  receiver.accept(store.read(command!) as ServerEvent);
  receiver.accept({ type: "session.history", messages: ["fresh"] });
  assert.deepEqual(output, [{ type: "session.history", messages: ["fresh"] }]);
});

test("the real relay connector serves authenticated pages without recursively transferring page replies", { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-transfer-relay-"));
  const pairing = PairingStore.load(dir);
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  let socket: WebSocket | undefined;
  const event = { type: "session.history", sessionId: "s", messages: ["x".repeat(5 * 1024 * 1024)] };
  let resolve!: (event: ServerEvent) => void;
  let reject!: (error: unknown) => void;
  const delivered = new Promise<ServerEvent>((yes, no) => { resolve = yes; reject = no; });
  const receiver = new EventTransferReceiver({
    send: async command => { for (const frame of frameMessages(sealFrame(pairing.roomKey(), command))) socket!.send(frame); },
    emit: resolve,
    fault: reject,
  });
  const reassemble = createFrameReassembler({ onReject: reject });
  server.on("connection", client => {
    socket = client;
    client.send(JSON.stringify({ t: "ready" }));
    client.on("message", data => {
      const envelope = JSON.parse(String(data));
      if (envelope.t !== "frame") return;
      const full = reassemble(envelope);
      if (full) receiver.accept(openFrame(pairing.roomKey(), full).data as ServerEvent);
    });
  });
  const port = (server.address() as { port: number }).port;
  const connector = new RelayConnector({ url: `ws://127.0.0.1:${port}`, room: "test", roomToken: "test" },
    () => reject(new Error("transfer.read must not reach the application command router")), { pairing });
  try {
    connector.start();
    const deadline = Date.now() + 2000;
    while (!connector.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(connector.connected);
    connector.sendEvent(event);
    assert.deepEqual(await delivered, event);
  } finally {
    receiver.reset();
    reassemble.reset();
    connector.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("active slow readers renew the idle lease, but cannot retain a snapshot forever", () => {
  let now = 0;
  const store = new EventTransferStore(() => now, 1);
  const offer = store.offer({ type: "history", data: "test" })!;
  const transferId = (offer.transfer as { id: string }).id;
  for (let i = 1; i <= 5; i++) {
    now = i * 110_000;
    assert.equal(store.read({ transferId, offset: 0 }).error, undefined);
  }
  now = 600_001;
  assert.match(String(store.read({ transferId, offset: 0 }).error), /expired/);
  store.clear();
});
