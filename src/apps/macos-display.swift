// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A preview display for macOS apps. macOS has no private displays, so this
// serves one app's windows as a VNC display instead: the same protocol Xvnc
// speaks on Linux, on a private Unix socket, so Bivy's viewer, relay and
// screenshots work unchanged.
//
//   macos-display check [--prompt]              permissions, as JSON
//   macos-display serve <socket> <token> <scale>
//   macos-display run -- <command> [args…]      starts the app (see below)
//
// The app is found by its environment: Bivy starts it through `run` with
// BIVY_MAC_DISPLAY=<token>, and any process descending from a process that
// carries it is the app's. The launcher matters because signed apps with the
// hardened runtime hide their environment. Its largest window is the screen; other
// windows of the app (dialogs, menus) are drawn over it. Pictures come from
// ScreenCaptureKit (Screen Recording permission); clicks, keys and window
// sizing go through Accessibility. Keys are sent to the app only; clicks land
// only when the app's window is the one under the pointer.
import AppKit
import ApplicationServices
import CoreMedia
import CoreVideo
@preconcurrency import ScreenCaptureKit
import zlib

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

func say(_ line: String) { print(line) }
func warn(_ line: String) { FileHandle.standardError.write(Data((line + "\n").utf8)) }

// MARK: - Permissions

func permissions(prompt: Bool) -> String {
  if prompt {
    _ = CGRequestScreenCaptureAccess()
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  }
  return "{\"screenRecording\":\(CGPreflightScreenCaptureAccess()),\"accessibility\":\(AXIsProcessTrusted())}"
}

// MARK: - Which windows are the app's

/// A process's environment, read like `ps -E` does (same user only).
func environment(_ pid: pid_t) -> [[UInt8]] {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return [] }
  var buffer = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > 4 else { return [] }
  let argc = Int(buffer.withUnsafeBytes { $0.load(as: Int32.self) })
  var i = 4
  while i < size && buffer[i] != 0 { i += 1 } // executable path
  while i < size && buffer[i] == 0 { i += 1 } // padding
  var strings: [[UInt8]] = []
  while i < size {
    let start = i
    while i < size && buffer[i] != 0 { i += 1 }
    if i == start { break }
    strings.append(Array(buffer[start..<i]))
    i += 1
  }
  return Array(strings.dropFirst(argc))
}

func parentOf(_ pid: pid_t) -> pid_t {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? pid_t(info.pbi_ppid) : 0
}

/// `run`: starts the app as a child and stays its parent, passing signals on
/// and exiting as it does, so the app's processes can be traced back to it.
func run(_ command: [String]) -> Never {
  var child: pid_t = 0
  let argv = command.map { strdup($0) } + [nil]
  let status = posix_spawnp(&child, command[0], nil, nil, argv, environ)
  guard status == 0 else { warn("\(command[0]): \(String(cString: strerror(status)))"); exit(127) }
  for sig in [SIGTERM, SIGINT, SIGHUP, SIGQUIT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { kill(child, sig) }
    source.resume()
    forwarded.append(source)
  }
  DispatchQueue.global().async {
    var result: Int32 = 0
    while waitpid(child, &result, 0) < 0 && errno == EINTR {}
    exit(result & 0x7f == 0 ? (result >> 8) & 0xff : 128 + (result & 0x7f))
  }
  dispatchMain()
}
nonisolated(unsafe) var forwarded: [DispatchSourceSignal] = []

struct Win { let id: CGWindowID; let pid: pid_t; let layer: Int; let bounds: CGRect }
/// Dock, main menu and status items: never part of an app's picture.
let SYSTEM_LAYERS: Set<Int> = [20, 24, 25]

/// On-screen windows, front to back, in global top-left coordinates (points).
func onScreenWindows() -> [Win] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  return list.compactMap { info in
    guard let id = info[kCGWindowNumber as String] as? CGWindowID, let pid = info[kCGWindowOwnerPID as String] as? pid_t,
          let layer = info[kCGWindowLayer as String] as? Int, let dict = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary), bounds.width > 1, bounds.height > 1 else { return nil }
    if let alpha = info[kCGWindowAlpha as String] as? Double, alpha <= 0 { return nil }
    return Win(id: id, pid: pid, layer: layer, bounds: bounds)
  }
}

/// The visible part of the screen holding `point` (no menu bar or Dock), in
/// global top-left coordinates.
func visibleArea(at point: CGPoint) -> CGRect? {
  guard let primary = NSScreen.screens.first?.frame.height else { return nil }
  for screen in NSScreen.screens {
    let f = screen.frame, v = screen.visibleFrame
    let frame = CGRect(x: f.minX, y: primary - f.maxY, width: f.width, height: f.height)
    if frame.contains(point) { return CGRect(x: v.minX, y: primary - v.maxY, width: v.width, height: v.height) }
  }
  return nil
}

func axValue<T>(_ element: AXUIElement, _ attribute: String) -> T? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
  return value as? T
}
func axPoint(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> CGRect? {
  guard let value: AXValue = axValue(element, attribute) else { return nil }
  if type == .cgPoint { var p = CGPoint.zero; AXValueGetValue(value, type, &p); return CGRect(origin: p, size: .zero) }
  var s = CGSize.zero; AXValueGetValue(value, type, &s); return CGRect(origin: .zero, size: s)
}
/// The Accessibility element for a window, matched by its frame.
func axWindow(_ win: Win) -> AXUIElement? {
  let app = AXUIElementCreateApplication(win.pid)
  let windows: [AXUIElement] = axValue(app, kAXWindowsAttribute) ?? []
  return windows.first { w in
    guard let p = axPoint(w, kAXPositionAttribute, .cgPoint)?.origin, let s = axPoint(w, kAXSizeAttribute, .cgSize)?.size else { return false }
    return abs(p.x - win.bounds.minX) < 2 && abs(p.y - win.bounds.minY) < 2 && abs(s.width - win.bounds.width) < 2 && abs(s.height - win.bounds.height) < 2
  } ?? axValue(app, kAXMainWindowAttribute)
}

// MARK: - Keys

/// US-layout key codes for the characters a keysym can name.
let KEYCODES: [Character: UInt16] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
  "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
  "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
  "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
  "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, " ": 0x31, "`": 0x32,
]
/// Shifted characters, by the key they share.
let SHIFTED: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]
/// X keysyms for keys without a character.
let SPECIAL: [UInt32: UInt16] = [
  0xff0d: 0x24, 0xff8d: 0x4C, 0xff09: 0x30, 0xff08: 0x33, 0xff1b: 0x35, 0xffff: 0x75, 0xff63: 0x72,
  0xff50: 0x73, 0xff57: 0x77, 0xff55: 0x74, 0xff56: 0x79, 0xff51: 0x7B, 0xff52: 0x7E, 0xff53: 0x7C, 0xff54: 0x7D,
  0xffbe: 0x7A, 0xffbf: 0x78, 0xffc0: 0x63, 0xffc1: 0x76, 0xffc2: 0x60, 0xffc3: 0x61, 0xffc4: 0x62, 0xffc5: 0x64,
  0xffc6: 0x65, 0xffc7: 0x6D, 0xffc8: 0x67, 0xffc9: 0x6F,
]
/// Modifier keysyms: Control is Control, Alt/Meta is Option, Super (a Mac
/// keyboard's ⌘ in the browser) is Command.
let MODIFIERS: [UInt32: (code: UInt16, flag: CGEventFlags)] = [
  0xffe1: (0x38, .maskShift), 0xffe2: (0x3C, .maskShift), 0xffe3: (0x3B, .maskControl), 0xffe4: (0x3E, .maskControl),
  0xffe9: (0x3A, .maskAlternate), 0xffea: (0x3D, .maskAlternate), 0xffe7: (0x3A, .maskAlternate), 0xffe8: (0x3D, .maskAlternate),
  0xffeb: (0x37, .maskCommand), 0xffec: (0x36, .maskCommand),
]

func character(_ keysym: UInt32) -> Character? {
  let scalar = keysym >= 0x0100_0000 ? keysym - 0x0100_0000 : (keysym >= 0x20 && keysym <= 0xff ? keysym : 0)
  guard scalar != 0, let u = Unicode.Scalar(scalar) else { return nil }
  return Character(u)
}

// MARK: - Pixels

struct PixelFormat {
  var bigEndian = false, red = 16, green = 8, blue = 0
  /// Frames are BGRA; most viewers ask for exactly that or RGBX.
  func convert(_ src: UnsafePointer<UInt8>, _ dst: UnsafeMutablePointer<UInt8>, _ count: Int) {
    if !bigEndian && red == 16 && green == 8 && blue == 0 { dst.update(from: src, count: count * 4); return }
    for i in 0..<count {
      let b = UInt32(src[i * 4]), g = UInt32(src[i * 4 + 1]), r = UInt32(src[i * 4 + 2])
      let v = r << UInt32(red) | g << UInt32(green) | b << UInt32(blue)
      if bigEndian { dst[i * 4] = UInt8(v >> 24 & 255); dst[i * 4 + 1] = UInt8(v >> 16 & 255); dst[i * 4 + 2] = UInt8(v >> 8 & 255); dst[i * 4 + 3] = UInt8(v & 255) }
      else { dst[i * 4] = UInt8(v & 255); dst[i * 4 + 1] = UInt8(v >> 8 & 255); dst[i * 4 + 2] = UInt8(v >> 16 & 255); dst[i * 4 + 3] = UInt8(v >> 24 & 255) }
    }
  }
}

let TILE = 64
let ENCODING = (raw: Int32(0), zlib: Int32(6), desktopSize: Int32(-223), extendedDesktopSize: Int32(-308))

func be16(_ v: Int) -> [UInt8] { [UInt8(v >> 8 & 255), UInt8(v & 255)] }
func be32(_ v: Int32) -> [UInt8] { let u = UInt32(bitPattern: v); return [UInt8(u >> 24), UInt8(u >> 16 & 255), UInt8(u >> 8 & 255), UInt8(u & 255)] }

// MARK: - A connected viewer

final class Client {
  let fd: Int32
  var inbox: [UInt8] = []
  var outbox: [UInt8] = []
  /// Bytes of `outbox` already written; it is cleared once all are.
  var sent = 0
  var backlog: Int { outbox.count - sent }
  var stage = 0 // 0 version, 1 security choice, 2 client init, 3 running
  var format = PixelFormat()
  var encodings: Set<Int32> = []
  var wantsUpdate = false
  var full = true
  var sizeChanged = true
  var resizeReply: Int? // status for this client's own resize request
  var dirty: [Bool] = []
  var reader: DispatchSourceRead?
  var writer: DispatchSourceWrite?
  var writing = false
  private var zs: UnsafeMutablePointer<z_stream>?
  init(fd: Int32) { self.fd = fd }

  func deflated(_ input: inout [UInt8]) -> [UInt8] {
    if zs == nil {
      zs = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)
      zs!.initialize(to: z_stream())
      deflateInit_(zs!, 3, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
    }
    var out = [UInt8](repeating: 0, count: Int(deflateBound(zs!, UInt(input.count))) + 64)
    var produced = 0
    input.withUnsafeMutableBufferPointer { inp in
      zs!.pointee.next_in = inp.baseAddress; zs!.pointee.avail_in = UInt32(inp.count)
      repeat {
        if produced == out.count { out.append(contentsOf: [UInt8](repeating: 0, count: out.count)) }
        out.withUnsafeMutableBufferPointer { o in
          zs!.pointee.next_out = o.baseAddress! + produced; zs!.pointee.avail_out = UInt32(o.count - produced)
          deflate(zs!, Z_SYNC_FLUSH)
          produced = o.count - Int(zs!.pointee.avail_out)
        }
      } while zs!.pointee.avail_in > 0 || zs!.pointee.avail_out == 0
    }
    return Array(out[0..<produced])
  }
  func close() {
    reader?.cancel(); writer?.cancel()
    if let zs { deflateEnd(zs); zs.deallocate(); self.zs = nil }
  }
}

// MARK: - The display

final class Host: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let q = DispatchQueue(label: "sh.bivy.macos-display")
  let marker: [UInt8]
  let scale: CGFloat
  var known: [pid_t: Bool] = [:]
  var ours: [Win] = []
  var main: Win?
  var region = CGRect.zero
  var viewer: CGSize?
  var fitted: CGWindowID?
  var count = -1
  var width: Int, height: Int
  var frame: [UInt8]
  var clients: [Client] = []
  var mask: UInt8 = 0
  var flags: CGEventFlags = []
  var lastClick = (at: 0.0, point: CGPoint.zero, count: 0)
  var pasteboard = NSPasteboard.general.changeCount
  var stream: SCStream?
  var configuring = false
  var wanted: (ids: [CGWindowID], region: CGRect)?
  var captured: (ids: [CGWindowID], region: CGRect)?
  var acceptor: DispatchSourceRead?
  /// The last capture error, and when: retried after a pause, reported once.
  var failure = (message: "", at: 0.0)

  init(token: String, scale: CGFloat) {
    marker = Array("BIVY_MAC_DISPLAY=\(token)".utf8)
    self.scale = scale
    width = Int(1280 * scale); height = Int(800 * scale)
    frame = [UInt8](repeating: 0, count: width * height * 4)
  }

  func owns(_ pid: pid_t) -> Bool {
    if let hit = known[pid] { return hit }
    // It carries the token, or its parent is the app's (the launcher at the top).
    let parent = parentOf(pid)
    let hit = environment(pid).contains(marker) || (parent > 1 && parent != pid && owns(parent))
    known[pid] = hit
    return hit
  }

  /// Follows the app's windows: which is the screen, where it is, and what to capture.
  func tick() {
    if getppid() == 1 { exit(0) } // Bivy went away
    let all = onScreenWindows()
    known = known.filter { entry in all.contains { $0.pid == entry.key } }
    ours = all.filter { !SYSTEM_LAYERS.contains($0.layer) && owns($0.pid) }
    let normal = ours.filter { $0.layer == 0 }
    if normal.count != count { count = normal.count; say("windows \(count)") }
    main = normal.max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
    if let main, main.id != fitted { fitted = main.id; fit() }
    guard let main else { return }
    region = main.bounds.integral
    let ids = ours.filter { $0.bounds.intersects(region) }.map(\.id)
    let retry = Date().timeIntervalSince1970 - failure.at > 2
    if retry, captured?.ids != ids || captured?.region != region { capture(ids: ids, region: region) }
    clipboard()
  }

  // MARK: Capture

  func capture(ids: [CGWindowID], region: CGRect) {
    wanted = (ids, region)
    guard !configuring else { return }
    configuring = true
    captured = wanted
    let scale = self.scale
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { ids.contains($0.windowID) }
        let center = CGPoint(x: region.midX, y: region.midY)
        guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(center) }) ?? content.displays.first else { throw CocoaError(.featureUnsupported) }
        let bounds = CGDisplayBounds(display.displayID)
        let config = SCStreamConfiguration()
        config.sourceRect = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
        config.width = min(8192, max(1, Int(region.width * scale)))
        config.height = min(8192, max(1, Int(region.height * scale)))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 4
        let filter = SCContentFilter(display: display, including: windows)
        if let stream = self.stream {
          try await stream.updateContentFilter(filter)
          try await stream.updateConfiguration(config)
        } else {
          let stream = SCStream(filter: filter, configuration: config, delegate: self)
          try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.q)
          try await stream.startCapture()
          self.q.async { self.stream = stream }
        }
      } catch {
        let message = error.localizedDescription
        self.q.async {
          if message != self.failure.message { warn("capture: \(message)") }
          self.failure = (message, Date().timeIntervalSince1970); self.captured = nil
        }
      }
      self.q.async {
        self.configuring = false
        if let wanted = self.wanted, self.captured?.ids != wanted.ids || self.captured?.region != wanted.region { self.capture(ids: wanted.ids, region: wanted.region) }
      }
    }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    warn("capture stopped: \(error.localizedDescription)")
    q.async { if self.stream === stream { self.stream = nil; self.captured = nil } }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
          let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
          let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self) else { return }
    let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels), stride = CVPixelBufferGetBytesPerRow(pixels)
    let resized = w != width || h != height
    if resized {
      width = w; height = h
      frame = [UInt8](repeating: 0, count: w * h * 4)
      for client in clients { client.sizeChanged = true; client.full = true }
    }
    let columns = (w + TILE - 1) / TILE, rows = (h + TILE - 1) / TILE
    var changed = [Bool](repeating: resized, count: columns * rows)
    frame.withUnsafeMutableBufferPointer { fb in
      for y in 0..<h {
        let src = base + y * stride, dst = fb.baseAddress! + y * w * 4
        for column in 0..<columns where !changed[(y / TILE) * columns + column] {
          let x = column * TILE, n = min(TILE, w - x) * 4
          if memcmp(src + x * 4, dst + x * 4, n) != 0 { changed[(y / TILE) * columns + column] = true }
        }
        dst.update(from: src, count: w * 4)
      }
    }
    for client in clients {
      if client.dirty.count != changed.count { client.dirty = changed; client.full = true }
      else { for i in changed.indices where changed[i] { client.dirty[i] = true } }
      update(client)
    }
  }

  // MARK: Serving viewers

  func listen(path: String) {
    unlink(path)
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in _ = path.withCString { strncpy(buf.baseAddress!.assumingMemoryBound(to: CChar.self), $0, buf.count - 1) } }
    let old = umask(0o177)
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    umask(old)
    guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 16) == 0 else { warn("Couldn't listen on \(path)"); exit(1) }
    let accept = DispatchSource.makeReadSource(fileDescriptor: fd, queue: q)
    accept.setEventHandler { [self] in
      let peer = Darwin.accept(fd, nil, nil)
      guard peer >= 0 else { return }
      _ = fcntl(peer, F_SETFL, fcntl(peer, F_GETFL) | O_NONBLOCK)
      var on: Int32 = 1
      setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      let client = Client(fd: peer)
      clients.append(client)
      let reader = DispatchSource.makeReadSource(fileDescriptor: peer, queue: q)
      reader.setEventHandler { [self] in receive(client) }
      reader.setCancelHandler { Darwin.close(peer) }
      client.reader = reader
      reader.resume()
      send(client, Array("RFB 003.008\n".utf8))
    }
    accept.resume()
    acceptor = accept
  }

  func drop(_ client: Client) {
    guard let index = clients.firstIndex(where: { $0 === client }) else { return }
    clients.remove(at: index)
    client.close()
  }

  func send(_ client: Client, _ bytes: [UInt8]) {
    client.outbox.append(contentsOf: bytes)
    flush(client)
  }
  func flush(_ client: Client) {
    while client.backlog > 0 {
      let n = client.outbox.withUnsafeBytes { Darwin.write(client.fd, $0.baseAddress! + client.sent, client.backlog) }
      if n > 0 { client.sent += n; continue }
      if n < 0 && (errno == EAGAIN || errno == EINTR) { break }
      drop(client); return
    }
    if client.backlog == 0 {
      client.outbox.removeAll(keepingCapacity: true); client.sent = 0
      if client.writing { client.writer?.suspend(); client.writing = false }
      update(client)
    } else if !client.writing {
      if client.writer == nil {
        let writer = DispatchSource.makeWriteSource(fileDescriptor: client.fd, queue: q)
        writer.setEventHandler { [self] in flush(client) }
        client.writer = writer
      }
      client.writer!.resume(); client.writing = true
    }
  }

  func receive(_ client: Client) {
    var chunk = [UInt8](repeating: 0, count: 65536)
    let n = chunk.withUnsafeMutableBytes { Darwin.read(client.fd, $0.baseAddress, $0.count) }
    if n <= 0 { if n == 0 || (errno != EAGAIN && errno != EINTR) { drop(client) }; return }
    client.inbox.append(contentsOf: chunk[0..<n])
    while clients.contains(where: { $0 === client }), let used = handle(client, client.inbox), used > 0 { client.inbox.removeFirst(used) }
  }

  /// One message from a viewer: the bytes it used, or nil until more arrive.
  func handle(_ client: Client, _ m: [UInt8]) -> Int? {
    func u16(_ i: Int) -> Int { Int(m[i]) << 8 | Int(m[i + 1]) }
    func u32(_ i: Int) -> UInt32 { UInt32(m[i]) << 24 | UInt32(m[i + 1]) << 16 | UInt32(m[i + 2]) << 8 | UInt32(m[i + 3]) }
    switch client.stage {
    case 0:
      guard m.count >= 12 else { return nil }
      guard String(decoding: m[0..<12], as: UTF8.self).hasPrefix("RFB 003.") else { drop(client); return nil }
      if u16(8) == 0x3030 && m[10] == 0x33 { send(client, be32(1)); client.stage = 2 } // 3.3: the server picks None
      else { send(client, [1, 1]); client.stage = 1 }
      return 12
    case 1:
      guard m.count >= 1 else { return nil }
      guard m[0] == 1 else { drop(client); return nil }
      send(client, be32(0)); client.stage = 2
      return 1
    case 2:
      guard m.count >= 1 else { return nil }
      let name = Array("Bivy".utf8)
      send(client, be16(width) + be16(height) + [32, 24, 0, 1] + be16(255) + be16(255) + be16(255) + [16, 8, 0, 0, 0, 0] + be32(Int32(name.count)) + name)
      client.stage = 3
      return 1
    default: break
    }
    guard let type = m.first else { return nil }
    switch type {
    case 0: // SetPixelFormat
      guard m.count >= 20 else { return nil }
      guard m[4] == 32, m[7] != 0 else { drop(client); return nil }
      client.format = PixelFormat(bigEndian: m[6] != 0, red: Int(m[14]), green: Int(m[15]), blue: Int(m[16]))
      client.full = true
      return 20
    case 2: // SetEncodings
      guard m.count >= 4 else { return nil }
      let n = u16(2)
      guard m.count >= 4 + n * 4 else { return nil }
      client.encodings = Set((0..<n).map { Int32(bitPattern: u32(4 + $0 * 4)) })
      return 4 + n * 4
    case 3: // FramebufferUpdateRequest
      guard m.count >= 10 else { return nil }
      client.wantsUpdate = true
      if m[1] == 0 { client.full = true }
      update(client)
      return 10
    case 4: // KeyEvent
      guard m.count >= 8 else { return nil }
      key(down: m[1] != 0, keysym: u32(4))
      return 8
    case 5: // PointerEvent
      guard m.count >= 6 else { return nil }
      pointer(mask: m[1], x: u16(2), y: u16(4))
      return 6
    case 6: // ClientCutText
      guard m.count >= 8 else { return nil }
      let length = Int(Int32(bitPattern: u32(4)))
      guard length >= 0, length < 1 << 20 else { drop(client); return nil }
      guard m.count >= 8 + length else { return nil }
      let text = String(m[8..<8 + length].map { Character(Unicode.Scalar($0)) })
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
      pasteboard = NSPasteboard.general.changeCount
      return 8 + length
    case 251: // SetDesktopSize
      guard m.count >= 8 else { return nil }
      let screens = Int(m[6])
      guard m.count >= 8 + screens * 16 else { return nil }
      viewer = CGSize(width: CGFloat(u16(2)) / scale, height: CGFloat(u16(4)) / scale)
      client.resizeReply = main == nil ? 1 : 0
      fit()
      update(client)
      return 8 + screens * 16
    default:
      drop(client); return nil
    }
  }

  /// Sends what changed, if the viewer asked and has read what it was sent.
  func update(_ client: Client) {
    guard client.stage == 3, client.wantsUpdate, client.backlog < 1 << 20 else { return }
    let columns = (width + TILE - 1) / TILE, rows = (height + TILE - 1) / TILE
    if client.dirty.count != columns * rows { client.dirty = [Bool](repeating: true, count: columns * rows); client.full = true }
    let resize = client.sizeChanged || client.resizeReply != nil
    guard resize || client.full || client.dirty.contains(true) else { return }
    var rects: [[UInt8]] = []
    if resize {
      if client.encodings.contains(ENCODING.extendedDesktopSize) {
        let reason = client.resizeReply == nil ? 0 : 1
        rects.append(be16(reason) + be16(client.resizeReply ?? 0) + be16(width) + be16(height) + be32(ENCODING.extendedDesktopSize)
          + [1, 0, 0, 0] + be32(0) + be16(0) + be16(0) + be16(width) + be16(height) + be32(0))
      } else if client.sizeChanged && client.encodings.contains(ENCODING.desktopSize) {
        rects.append(be16(0) + be16(0) + be16(width) + be16(height) + be32(ENCODING.desktopSize))
      }
      if client.sizeChanged { client.full = true }
      client.sizeChanged = false; client.resizeReply = nil
    }
    if client.full { for i in client.dirty.indices { client.dirty[i] = true } }
    // Changed tiles, merged into runs along each row of tiles.
    for row in 0..<rows {
      var column = 0
      while column < columns {
        guard client.dirty[row * columns + column] else { column += 1; continue }
        let start = column
        while column < columns && client.dirty[row * columns + column] { client.dirty[row * columns + column] = false; column += 1 }
        let x = start * TILE, y = row * TILE, w = min(column * TILE, width) - x, h = min(TILE, height - y)
        rects.append(rectangle(client, x: x, y: y, w: w, h: h))
      }
    }
    client.full = false
    client.wantsUpdate = false
    send(client, [0, 0] + be16(rects.count) + rects.flatMap { $0 })
  }

  func rectangle(_ client: Client, x: Int, y: Int, w: Int, h: Int) -> [UInt8] {
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    frame.withUnsafeBufferPointer { fb in
      pixels.withUnsafeMutableBufferPointer { out in
        for row in 0..<h { client.format.convert(fb.baseAddress! + ((y + row) * width + x) * 4, out.baseAddress! + row * w * 4, w) }
      }
    }
    let head = be16(x) + be16(y) + be16(w) + be16(h)
    guard client.encodings.contains(ENCODING.zlib) else { return head + be32(ENCODING.raw) + pixels }
    let data = client.deflated(&pixels)
    return head + be32(ENCODING.zlib) + be32(Int32(data.count)) + data
  }

  /// Text the app copied goes to viewers (as Latin-1, like any VNC server).
  func clipboard() {
    let board = NSPasteboard.general
    guard board.changeCount != pasteboard else { return }
    pasteboard = board.changeCount
    guard frontmost(), let text = board.string(forType: .string) else { return }
    let bytes = text.unicodeScalars.map { $0.value < 256 ? UInt8($0.value) : UInt8(ascii: "?") }
    for client in clients where client.stage == 3 { send(client, [3, 0, 0, 0] + be32(Int32(bytes.count)) + bytes) }
  }

  // MARK: Windows and input

  func frontmost() -> Bool {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return false }
    return owns(pid)
  }
  /// Brings the app forward so its windows take clicks and keys.
  func raise() {
    guard let main, !frontmost() else { return }
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(main.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let window = axWindow(main) { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    for _ in 0..<10 where !frontmost() { usleep(30_000) }
  }
  /// Whether the app's window is what a click at `point` would hit.
  func reaches(_ point: CGPoint) -> Bool {
    let top = onScreenWindows().first { $0.bounds.contains(point) && ($0.layer >= 0 && $0.layer < 20 || owns($0.pid)) && !SYSTEM_LAYERS.contains($0.layer) }
    return top.map { owns($0.pid) } ?? false
  }

  /// The main window takes the viewer's size (within the visible screen),
  /// moved to its top-left corner. Apps with a minimum size stay larger and
  /// the viewer scales them down.
  func fit() {
    guard let main, let viewer, let area = visibleArea(at: CGPoint(x: main.bounds.midX, y: main.bounds.midY)), let window = axWindow(main) else { return }
    var origin = area.origin, size = CGSize(width: min(viewer.width, area.width), height: min(viewer.height, area.height))
    if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
    if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) }
  }

  func pointer(mask: UInt8, x: Int, y: Int) {
    let changed = mask ^ self.mask
    defer { self.mask = mask }
    guard main != nil else { return }
    let point = CGPoint(x: region.minX + CGFloat(x) / scale, y: region.minY + CGFloat(y) / scale)
    let buttons: [(bit: UInt8, button: CGMouseButton, down: CGEventType, up: CGEventType, drag: CGEventType)] = [
      (1, .left, .leftMouseDown, .leftMouseUp, .leftMouseDragged), (2, .center, .otherMouseDown, .otherMouseUp, .otherMouseDragged),
      (4, .right, .rightMouseDown, .rightMouseUp, .rightMouseDragged),
    ]
    let held = buttons.first { mask & $0.bit != 0 && changed & $0.bit == 0 }
    if changed & 7 == 0 {
      // Hover only over the app, so the Mac's own pointer isn't pulled around.
      if held != nil || reaches(point) { post(mouse: held?.drag ?? .mouseMoved, at: point, button: held?.button ?? .left) }
    }
    for b in buttons where changed & b.bit != 0 {
      let down = mask & b.bit != 0
      if down {
        if !reaches(point) { raise() }
        guard reaches(point) else { continue } // something else is on top: never click it
        let now = Date().timeIntervalSince1970
        let again = now - lastClick.at < NSEvent.doubleClickInterval && hypot(point.x - lastClick.point.x, point.y - lastClick.point.y) < 4
        lastClick = (now, point, again ? lastClick.count + 1 : 1)
      }
      post(mouse: down ? b.down : b.up, at: point, button: b.button, clicks: lastClick.count)
    }
    // Wheel "buttons" 4–7 are pressed once per step.
    for (bit, dx, dy) in [(UInt8(8), 0, 1), (16, 0, -1), (32, 1, 0), (64, -1, 0)] where changed & bit != 0 && mask & bit != 0 && reaches(point) {
      guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy * 50), wheel2: Int32(dx * 50), wheel3: 0) else { continue }
      event.location = point
      event.post(tap: .cghidEventTap)
    }
  }
  func post(mouse type: CGEventType, at point: CGPoint, button: CGMouseButton, clicks: Int = 0) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    if clicks > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
    event.flags = flags
    event.post(tap: .cghidEventTap)
  }

  /// Keys go to the app's process only, never to whatever else has focus.
  func key(down: Bool, keysym: UInt32) {
    guard let main else { return }
    if down { raise() }
    if let modifier = MODIFIERS[keysym] {
      if down { flags.insert(modifier.flag) } else { flags.remove(modifier.flag) }
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: modifier.code, keyDown: down) else { return }
      event.type = .flagsChanged
      event.flags = flags
      event.postToPid(main.pid)
      return
    }
    var code = SPECIAL[keysym]
    var shift = false
    let char = code == nil ? character(keysym) : nil
    if let char {
      let lower = Character(char.lowercased())
      if let base = SHIFTED[char] { code = KEYCODES[base]; shift = true }
      else { code = KEYCODES[lower]; shift = char != lower }
    }
    guard code != nil || char != nil, let event = CGEvent(keyboardEventSource: nil, virtualKey: code ?? 0, keyDown: down) else { return }
    event.flags = shift ? flags.union(.maskShift) : flags
    // Plain typing carries the character itself, so any keyboard layout types
    // what was meant; shortcuts go by key.
    if let char, flags.isDisjoint(with: [.maskCommand, .maskControl]) {
      let units = Array(String(char).utf16)
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    event.postToPid(main.pid)
  }
}

// MARK: - Entry

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "run" where args.count > 3 && args[2] == "--":
  run(Array(args[3...]))
case "check":
  say(permissions(prompt: args.contains("--prompt")))
case "serve" where args.count == 5:
  let host = Host(token: args[3], scale: CGFloat(Double(args[4]) == 2 ? 2 : 1))
  host.q.sync { host.listen(path: args[2]) }
  let timer = DispatchSource.makeTimerSource(queue: host.q)
  timer.schedule(deadline: .now(), repeating: .milliseconds(200))
  timer.setEventHandler { host.tick() }
  timer.resume()
  say("ready")
  RunLoop.main.run()
default:
  warn("Usage: macos-display check [--prompt] | serve <socket> <token> <scale> | run -- <command> [args…]")
  exit(2)
}
