// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import net from "node:net";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/** An X authority file with one MIT-MAGIC-COOKIE-1 for any display number, so
 * only processes Bivy hands the file to can connect. */
export function writeXauthority(file: string, cookie = randomBytes(16)): Buffer {
  const field = (data: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(data.length); return Buffer.concat([len, data]); };
  const family = Buffer.from([0xff, 0xff]); // FamilyWild
  fs.writeFileSync(file, Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(cookie)]), { mode: 0o600 });
  return cookie;
}

const pad = (n: number) => (4 - (n % 4)) % 4;
// Core protocol numbers used below (X11 protocol, little-endian client).
const OP = { ChangeWindowAttributes: 2, MapWindow: 8, ConfigureWindow: 12, GetGeometry: 14, ChangeProperty: 18, GetProperty: 20, SendEvent: 25, SetInputFocus: 42, QueryExtension: 98 } as const;
/** RandR minor opcodes. */
const RR = { QueryVersion: 0, SetScreenSize: 7 } as const;
const EV = { DestroyNotify: 17, UnmapNotify: 18, MapRequest: 20, ConfigureNotify: 22, ConfigureRequest: 23 } as const;
const MASK = { StructureNotify: 1 << 17, SubstructureNotify: 1 << 19, SubstructureRedirect: 1 << 20 } as const;
const CFG = { x: 1, y: 2, width: 4, height: 8, border: 16 } as const;
const ATOM = { STRING: 31, RESOURCE_MANAGER: 23, WM_NORMAL_HINTS: 40, WM_SIZE_HINTS: 41, WINDOW: 33, WM_TRANSIENT_FOR: 68 } as const;
/** WM_SIZE_HINTS flag: the program set a minimum size. */
const P_MIN_SIZE = 1 << 4;

/** A window manager with one rule, sized for previews: every top-level window
 * fills the screen, dialogs are centered at their own size, and everything is
 * refit when the viewer resizes the display. A window that can't shrink to the
 * viewer's size grows the screen instead, and the viewer scales it down, so
 * nothing is cut off. Pure protocol, no dependencies. */
export class FitWindowManager {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private root = 0;
  private width = 0;
  private height = 0;
  private ready = false;
  /** Pending replies by sequence number: the raw reply, or undefined on error. */
  private replies = new Map<number, (reply: Buffer | undefined) => void>();
  /** Mapped windows we manage; `size` is what the app asked for (dialogs keep
   * it), `min` the smallest it can draw. */
  private windows = new Map<number, { dialog: boolean; size: [number, number]; min: [number, number] }>();
  /** The size the viewer asked for, and the size we last set ourselves. */
  private viewer: [number, number] = [0, 0];
  private own?: [number, number];
  private randr = 0;

  /** Resolves once the WM owns the root window; rejects if another WM does. */
  /** `dpi` is published as Xft.dpi, which Chromium/Electron and others scale by. */
  start(socketPath: string, cookie: Buffer, dpi = 96): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      this.socket = socket;
      socket.on("error", (error) => { if (!this.ready) reject(error); });
      socket.on("close", () => { if (!this.ready) reject(new Error("The display closed the window manager's connection.")); });
      const name = Buffer.from("MIT-MAGIC-COOKIE-1");
      const setup = Buffer.alloc(12);
      setup.write("l", 0); setup.writeUInt16LE(11, 2); setup.writeUInt16LE(0, 4);
      setup.writeUInt16LE(name.length, 6); setup.writeUInt16LE(cookie.length, 8);
      socket.write(Buffer.concat([setup, name, Buffer.alloc(pad(name.length)), cookie, Buffer.alloc(pad(cookie.length))]));
      socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try {
          if (!this.ready) {
            if (this.buffer.length < 8) return;
            const total = 8 + this.buffer.readUInt16LE(6) * 4;
            if (this.buffer.length < total) return;
            const reply = this.buffer.subarray(0, total);
            this.buffer = this.buffer.subarray(total);
            if (reply[0] !== 1) { reject(new Error(`The display refused the window manager: ${reply.subarray(8, 8 + reply[1]!).toString()}`)); socket.destroy(); return; }
            this.parseSetup(reply);
            this.ready = true;
            this.viewer = [this.width, this.height];
            const resources = Buffer.from(`Xft.dpi:\t${dpi}\n`);
            this.request(OP.ChangeProperty, 0, Buffer.concat([u32(this.root, ATOM.RESOURCE_MANAGER, ATOM.STRING, 8, resources.length), resources, Buffer.alloc(pad(resources.length))]));
            const name = Buffer.from("RANDR");
            this.query(OP.QueryExtension, Buffer.concat([u16pair(name.length, 0), name, Buffer.alloc(pad(name.length))]), (reply) => {
              if (!reply?.[8]) return;
              this.randr = reply[9]!;
              this.request(this.randr, RR.QueryVersion, u32(1, 5));
            });
            // Redirecting the root's substructure is what makes us the WM.
            const seq = this.request(OP.ChangeWindowAttributes, 0, u32(this.root, 0x800, MASK.SubstructureRedirect | MASK.SubstructureNotify | MASK.StructureNotify));
            this.replies.set(seq, () => reject(new Error("Another window manager already runs on this display.")));
            // A no-reply request can't be confirmed directly; a reply to the next
            // request arrives in order, so it means the first one passed.
            this.query(OP.GetGeometry, u32(this.root), () => { this.replies.delete(seq); resolve(); });
          }
          this.drain();
        } catch { socket.destroy(); }
      });
    });
  }
  stop(): void { this.socket?.destroy(); this.socket = undefined; }
  get size(): [number, number] { return [this.width, this.height]; }
  /** Top-level windows currently shown. */
  get count(): number { return this.windows.size; }

  private parseSetup(reply: Buffer): void {
    const vendorLength = reply.readUInt16LE(24);
    const formats = reply[29]!;
    const screen = 40 + vendorLength + pad(vendorLength) + formats * 8;
    this.root = reply.readUInt32LE(screen);
    this.width = reply.readUInt16LE(screen + 20);
    this.height = reply.readUInt16LE(screen + 22);
  }
  private request(opcode: number, data: number, body: Buffer): number {
    const header = Buffer.alloc(4);
    header[0] = opcode; header[1] = data; header.writeUInt16LE(1 + body.length / 4, 2);
    this.socket?.write(Buffer.concat([header, body]));
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }
  private query(opcode: number, body: Buffer, done: (reply: Buffer | undefined) => void): void {
    this.replies.set(this.request(opcode, 0, body), done);
  }
  private drain(): void {
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0]!;
      const length = kind === 1 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32;
      if (this.buffer.length < length) return;
      const packet = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const seq = packet.readUInt16LE(2);
      if (kind === 0 || kind === 1) {
        const done = this.replies.get(seq); this.replies.delete(seq);
        done?.(kind === 1 ? packet : undefined);
        continue;
      }
      this.event(kind & 0x7f, packet);
    }
  }
  private event(code: number, e: Buffer): void {
    if (code === EV.MapRequest) {
      const window = e.readUInt32LE(8);
      // The size it was created (or last configured) with, and whether it's a
      // dialog: dialogs name their parent and keep their size, centered.
      let size: [number, number] = [0, 0], min: [number, number] = [0, 0];
      this.query(OP.GetGeometry, u32(window), (reply) => { if (reply) size = [reply.readUInt16LE(16), reply.readUInt16LE(18)]; });
      this.query(OP.GetProperty, u32(window, ATOM.WM_NORMAL_HINTS, ATOM.WM_SIZE_HINTS, 0, 18), (reply) => {
        if (reply && reply.readUInt32LE(16) >= 7 && reply.readUInt32LE(32) & P_MIN_SIZE) min = [reply.readInt32LE(32 + 20), reply.readInt32LE(32 + 24)];
      });
      this.query(OP.GetProperty, u32(window, ATOM.WM_TRANSIENT_FOR, ATOM.WINDOW, 0, 1), (reply) => {
        if (!reply) return; // gone already
        const dialog = reply.readUInt32LE(16) > 0 && reply.readUInt32LE(32) > 0;
        this.windows.set(window, { dialog, size, min: min.map((v) => Math.max(0, Math.min(v, 8192))) as [number, number] });
        if (!this.resize()) this.fit(window);
        this.request(OP.MapWindow, 0, u32(window));
        this.request(OP.SetInputFocus, 2, u32(window, 0));
      });
    } else if (code === EV.ConfigureRequest) {
      const window = e.readUInt32LE(8);
      const size: [number, number] = [e.readUInt16LE(20), e.readUInt16LE(22)];
      const managed = this.windows.get(window);
      if (managed) { managed.size = size; this.fit(window); return; }
      // Not shown yet: honour it; the map request decides the final geometry.
      this.configure(window, e.readInt16LE(16), e.readInt16LE(18), size[0], size[1]);
    } else if (code === EV.DestroyNotify || code === EV.UnmapNotify) {
      const window = e.readUInt32LE(8);
      if (e.readUInt32LE(4) === this.root && this.windows.delete(window)) this.resize();
    } else if (code === EV.ConfigureNotify && e.readUInt32LE(8) === this.root) {
      // The display changed size: refit everything to the new screen. If the
      // viewer did it (not us), remember what it asked for.
      this.width = e.readUInt16LE(20); this.height = e.readUInt16LE(22);
      if (!this.own || this.own[0] !== this.width || this.own[1] !== this.height) { this.viewer = [this.width, this.height]; this.own = undefined; }
      if (this.resize()) return;
      for (const window of this.windows.keys()) this.fit(window);
    }
  }
  /** Grow the screen past the viewer's size when a window can't shrink that
   * far; back to the viewer's size when it can. True if a resize was sent (the
   * refit follows when the display reports its new size). */
  private resize(): boolean {
    if (!this.randr) return false;
    let [w, h] = this.viewer;
    for (const { dialog, min } of this.windows.values()) if (!dialog) { w = Math.max(w, min[0]); h = Math.max(h, min[1]); }
    if (w === this.width && h === this.height) return false;
    this.own = [w, h];
    const body = Buffer.alloc(16);
    body.writeUInt32LE(this.root, 0); body.writeUInt16LE(w, 4); body.writeUInt16LE(h, 6);
    body.writeUInt32LE(Math.round(w * 25.4 / 96), 8); body.writeUInt32LE(Math.round(h * 25.4 / 96), 12);
    const seq = this.request(this.randr, RR.SetScreenSize, body);
    // Refused (e.g. too large): stop resizing and fit to the screen we have.
    // A later reply means it was accepted, so drop the error handler.
    this.replies.set(seq, () => { this.randr = 0; this.own = undefined; for (const window of this.windows.keys()) this.fit(window); });
    this.query(OP.GetGeometry, u32(this.root), () => this.replies.delete(seq));
    return true;
  }
  private fit(window: number): void {
    const managed = this.windows.get(window);
    if (!managed) return;
    if (!managed.dialog) { this.configure(window, 0, 0, this.width, this.height); return; }
    const w = Math.min(Math.max(managed.size[0], 1), this.width), h = Math.min(Math.max(managed.size[1], 1), this.height);
    this.configure(window, Math.floor((this.width - w) / 2), Math.floor((this.height - h) / 2), w, h);
  }
  private configure(window: number, x: number, y: number, width: number, height: number): void {
    const body = Buffer.alloc(28);
    body.writeUInt32LE(window, 0);
    body.writeUInt16LE(CFG.x | CFG.y | CFG.width | CFG.height | CFG.border, 4);
    body.writeInt32LE(x, 8); body.writeInt32LE(y, 12);
    body.writeUInt32LE(Math.max(1, width), 16); body.writeUInt32LE(Math.max(1, height), 20); body.writeUInt32LE(0, 24);
    this.request(OP.ConfigureWindow, 0, body);
    // ICCCM: tell the client its geometry even when nothing changed, or
    // toolkits that asked for another size wait for an answer and never paint.
    const event = Buffer.alloc(32);
    event[0] = EV.ConfigureNotify;
    event.writeUInt32LE(window, 4); event.writeUInt32LE(window, 8);
    event.writeInt16LE(x, 16); event.writeInt16LE(y, 18);
    event.writeUInt16LE(Math.max(1, width), 20); event.writeUInt16LE(Math.max(1, height), 22);
    this.request(OP.SendEvent, 0, Buffer.concat([u32(window, MASK.StructureNotify), event]));
  }
}

function u16pair(a: number, b: number): Buffer { const out = Buffer.alloc(4); out.writeUInt16LE(a, 0); out.writeUInt16LE(b, 2); return out; }
function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32LE(value >>> 0, i * 4));
  return out;
}
