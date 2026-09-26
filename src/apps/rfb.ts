// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import net from "node:net";
import { deflateSync } from "node:zlib";

/** Reads exact byte counts from a stream. */
class Reader {
  private buffer = Buffer.alloc(0);
  /** Chunks not yet joined onto `buffer`: joined once enough have arrived, so a large frame isn't copied per chunk. */
  private chunks: Buffer[] = [];
  private queued = 0;
  private waiting?: { n: number; resolve: (b: Buffer) => void };
  private failure?: Error;
  private reject?: (e: Error) => void;
  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => { this.chunks.push(chunk); this.queued += chunk.length; this.pump(); });
    const fail = (error: Error) => { this.failure = error; this.reject?.(error); };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The display closed the connection.")));
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failure && this.buffer.length + this.queued < n) { reject(this.failure); return; }
      this.waiting = { n, resolve }; this.reject = reject; this.pump();
    });
  }
  private pump(): void {
    if (!this.waiting || this.buffer.length + this.queued < this.waiting.n) return;
    if (this.buffer.length < this.waiting.n) { this.buffer = Buffer.concat([this.buffer, ...this.chunks]); this.chunks = []; this.queued = 0; }
    const { n, resolve } = this.waiting;
    this.waiting = undefined;
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    resolve(out);
  }
}

/** Joins a VNC server (security type None) as a shared client, so open viewers
 * stay connected: the connection and the display's size. */
async function join(socket: net.Socket): Promise<{ reader: Reader; width: number; height: number }> {
  const reader = new Reader(socket);
  const version = (await reader.read(12)).toString("latin1");
  if (!/^RFB 003\.\d{3}\n$/.test(version)) throw new Error("Not a VNC display.");
  socket.write("RFB 003.008\n");
  const types = await reader.read((await reader.read(1))[0]!);
  if (!types.includes(1)) throw new Error("The display requires a password.");
  socket.write(Buffer.from([1]));
  if ((await reader.read(4)).readUInt32BE(0) !== 0) throw new Error("The display refused the connection.");
  socket.write(Buffer.from([1]));
  const init = await reader.read(24);
  await reader.read(init.readUInt32BE(20)); // desktop name
  return { reader, width: init.readUInt16BE(0), height: init.readUInt16BE(2) };
}

/** Pointer and key events, as a viewer sends them; `wait` pauses between them. */
export type InputEvent = { pointer: { x: number; y: number; buttons: number } } | { key: { keysym: number; down: boolean } } | { wait: number };

/** Sends input to a display the way a viewer would, so it works for any VNC
 * display. Returns the display's size; points outside it are refused. */
export async function sendInput(socketPath: string, events: InputEvent[], timeoutMs = 10_000): Promise<{ width: number; height: number }> {
  const socket = net.connect(socketPath);
  const timer = setTimeout(() => socket.destroy(new Error("The display didn't answer in time.")), timeoutMs);
  try {
    const { width, height } = await join(socket);
    for (const event of events) if ("pointer" in event && (event.pointer.x >= width || event.pointer.y >= height)) {
      throw new Error(`${event.pointer.x},${event.pointer.y} is outside the app, which is ${width}×${height} pixels (the size of its screenshot).`);
    }
    for (const event of events) {
      if ("wait" in event) { await new Promise((r) => setTimeout(r, event.wait)); continue; }
      const message = Buffer.alloc(8);
      if ("pointer" in event) { message[0] = 5; message[1] = event.pointer.buttons; message.writeUInt16BE(event.pointer.x, 2); message.writeUInt16BE(event.pointer.y, 4); }
      else { message[0] = 4; message[1] = event.key.down ? 1 : 0; message.writeUInt32BE(event.key.keysym >>> 0, 4); }
      await new Promise<void>((resolve, reject) => socket.write("pointer" in event ? message.subarray(0, 6) : message, (error) => error ? reject(error) : resolve()));
    }
    return { width, height };
  } finally { clearTimeout(timer); socket.end(); }
}

/** One full frame from a VNC server, as packed RGB. */
export async function captureFrame(socketPath: string, timeoutMs = 10_000): Promise<{ width: number; height: number; rgb: Buffer }> {
  const socket = net.connect(socketPath);
  const timer = setTimeout(() => socket.destroy(new Error("The display didn't answer in time.")), timeoutMs);
  try {
    const { reader, width, height } = await join(socket);
    // 32 bpp true colour, little-endian, red at bit 16: bytes arrive B, G, R, X.
    const format = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]); // Raw only
    const request = Buffer.alloc(10);
    request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8);
    socket.write(Buffer.concat([format, encodings, request]));
    const rgb = Buffer.alloc(width * height * 3);
    for (;;) {
      const type = (await reader.read(1))[0];
      if (type === 2) continue; // bell
      if (type === 3) { const head = await reader.read(7); await reader.read(head.readUInt32BE(3)); continue; } // clipboard
      if (type !== 0) throw new Error("Unexpected message from the display.");
      const rects = (await reader.read(3)).readUInt16BE(1);
      for (let r = 0; r < rects; r++) {
        const head = await reader.read(12);
        const x = head.readUInt16BE(0), y = head.readUInt16BE(2), w = head.readUInt16BE(4), h = head.readUInt16BE(6);
        if (head.readInt32BE(8) !== 0) throw new Error("Unexpected encoding from the display.");
        const pixels = await reader.read(w * h * 4);
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          if (x + col >= width || y + row >= height) continue;
          const from = (row * w + col) * 4, to = ((y + row) * width + x + col) * 3;
          rgb[to] = pixels[from + 2]!; rgb[to + 1] = pixels[from + 1]!; rgb[to + 2] = pixels[from]!;
        }
      }
      return { width, height, rgb };
    }
  } finally { clearTimeout(timer); socket.destroy(); }
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data: Buffer): number { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
