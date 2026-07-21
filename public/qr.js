/*
 * Minimal self-contained QR Code encoder (byte mode, ECC level L, versions
 * 1-20) with mask selection and canvas rendering. No external dependencies,
 * no network calls — important because we encode private LAN pairing URLs.
 *
 * Exposes: window.QRCode.toCanvas(canvasEl, text)
 *
 * Implements ISO/IEC 18004 essentials: GF(256) Reed-Solomon, function
 * patterns, data placement, 8 data masks with penalty scoring, and BCH
 * format/version information.
 */
(function () {
  "use strict";

  // GF(256) tables, primitive polynomial 0x11d.
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Reed-Solomon generator polynomial of given degree.
  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gmul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecCount) {
    // rsGenerator returns ecCount+1 coefficients with a leading 1 at [0].
    // The remainder uses the non-leading coefficients (length ecCount).
    var div = rsGenerator(ecCount).slice(1);
    var res = new Array(ecCount).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < ecCount; j++) {
        res[j] ^= gmul(div[j], factor);
      }
    }
    return res;
  }

  // Per-version ECC L block structure:
  // [ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2]
  var ECL = {
    1: [7, 1, 19, 0, 0],
    2: [10, 1, 34, 0, 0],
    3: [15, 1, 55, 0, 0],
    4: [20, 1, 80, 0, 0],
    5: [26, 1, 108, 0, 0],
    6: [18, 2, 68, 0, 0],
    7: [20, 2, 78, 0, 0],
    8: [24, 2, 97, 0, 0],
    9: [30, 2, 116, 0, 0],
    10: [18, 2, 68, 2, 69],
    11: [20, 4, 81, 0, 0],
    12: [24, 2, 92, 2, 93],
    13: [26, 4, 107, 0, 0],
    14: [30, 3, 115, 1, 116],
    15: [22, 5, 87, 1, 88],
    16: [24, 5, 98, 1, 99],
    17: [28, 1, 107, 5, 108],
    18: [30, 5, 120, 1, 121],
    19: [28, 3, 113, 4, 114],
    20: [28, 3, 107, 5, 108],
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
    14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
    17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90],
  }; 

  function totalDataCodewords(v) {
    var s = ECL[v];
    return s[1] * s[2] + s[3] * s[4];
  }

  function charCountBits(v) {
    return v <= 9 ? 8 : 16; // byte mode
  }

  function chooseVersion(byteLen) {
    for (var v = 1; v <= 20; v++) {
      var bits = 4 + charCountBits(v) + byteLen * 8;
      if (Math.ceil(bits / 8) <= totalDataCodewords(v)) return v;
    }
    throw new Error("Data too large for supported QR versions (1-20)");
  }

  function encodeData(bytes, v) {
    var bb = [];
    function put(val, len) {
      for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
    }
    put(0b0100, 4); // byte mode
    put(bytes.length, charCountBits(v));
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);

    var cap = totalDataCodewords(v) * 8;
    // Terminator
    for (var t = 0; t < 4 && bb.length < cap; t++) bb.push(0);
    // Byte align
    while (bb.length % 8 !== 0) bb.push(0);
    // Pad bytes
    var pads = [0xec, 0x11];
    var pi = 0;
    while (bb.length < cap) {
      put(pads[pi % 2], 8);
      pi++;
    }
    // To bytes
    var codewords = [];
    for (var b = 0; b < bb.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bb[b + k];
      codewords.push(byte);
    }
    return codewords;
  }

  function buildFinalSequence(codewords, v) {
    var s = ECL[v];
    var ecCount = s[0];
    var blocks = [];
    var idx = 0;
    function take(n) {
      var arr = codewords.slice(idx, idx + n);
      idx += n;
      return arr;
    }
    for (var b = 0; b < s[1]; b++) blocks.push(take(s[2]));
    for (var b2 = 0; b2 < s[3]; b2++) blocks.push(take(s[4]));

    var ecBlocks = blocks.map(function (data) {
      return rsEncode(data, ecCount);
    });

    var maxData = Math.max.apply(null, blocks.map(function (x) { return x.length; }));
    var result = [];
    for (var i = 0; i < maxData; i++) {
      for (var bl = 0; bl < blocks.length; bl++) {
        if (i < blocks[bl].length) result.push(blocks[bl][i]);
      }
    }
    for (var e = 0; e < ecCount; e++) {
      for (var bl2 = 0; bl2 < ecBlocks.length; bl2++) {
        result.push(ecBlocks[bl2][e]);
      }
    }
    return result;
  }

  // --- Matrix construction ---------------------------------------------
  function makeMatrix(size) {
    var m = [];
    var fn = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(null));
      fn.push(new Array(size).fill(false));
    }
    return { m: m, fn: fn, size: size };
  }

  function setFn(M, r, c, val) {
    M.m[r][c] = val;
    M.fn[r][c] = true;
  }

  function placeFinder(M, r, c) {
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= M.size || cc >= M.size) continue;
        var inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        var dark = inRing &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(M, rr, cc, !!dark);
      }
    }
  }

  function placeAlignment(M, v) {
    var pos = ALIGN[v];
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var r = pos[i], c = pos[j];
        // Skip if overlapping a finder pattern.
        if ((r <= 7 && c <= 7) || (r <= 7 && c >= M.size - 8) || (r >= M.size - 8 && c <= 7)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFn(M, r + dr, c + dc, dark);
          }
        }
      }
    }
  }

  function placeTimingAndDark(M, v) {
    for (var i = 8; i < M.size - 8; i++) {
      if (M.fn[6][i]) {} else setFn(M, 6, i, i % 2 === 0);
      if (M.fn[i][6]) {} else setFn(M, i, 6, i % 2 === 0);
    }
    setFn(M, 4 * v + 9, 8, true); // dark module
  }

  function reserveFormat(M) {
    var size = M.size;
    for (var i = 0; i <= 8; i++) {
      if (!M.fn[8][i]) setFn(M, 8, i, false);
      if (!M.fn[i][8]) setFn(M, i, 8, false);
    }
    for (var j = 0; j < 8; j++) {
      if (!M.fn[8][size - 1 - j]) setFn(M, 8, size - 1 - j, false);
      if (!M.fn[size - 1 - j][8]) setFn(M, size - 1 - j, 8, false);
    }
  }

  function reserveVersion(M, v) {
    if (v < 7) return;
    var size = M.size;
    for (var i = 0; i < 6; i++) {
      for (var j = 0; j < 3; j++) {
        setFn(M, i, size - 11 + j, false);
        setFn(M, size - 11 + j, i, false);
      }
    }
  }

  function maskFn(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function placeData(M, bits, mask) {
    var size = M.size;
    var idx = 0;
    var up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5; // skip vertical timing column
      for (var i = 0; i < size; i++) {
        var row = up ? size - 1 - i : i;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (M.fn[row][c]) continue;
          var dark = idx < bits.length ? bits[idx] === 1 : false;
          idx++;
          if (maskFn(mask, row, c)) dark = !dark;
          M.m[row][c] = dark;
        }
      }
      up = !up;
    }
  }

  function bchFormat(ecMaskValue) {
    var d = ecMaskValue << 10;
    var g = 0b10100110111;
    for (var i = 14; i >= 10; i--) {
      if ((d >> i) & 1) d ^= g << (i - 10);
    }
    return ((ecMaskValue << 10) | d) ^ 0b101010000010010;
  }

  function placeFormat(M, mask) {
    var size = M.size;
    var ecBits = 0b01; // level L
    var bits = bchFormat((ecBits << 3) | mask); // 15 bits, bit 0 = LSB
    function bit(i) { return ((bits >> i) & 1) ? true : false; }
    // Copy 1 — vertical strip in column 8 (and bottom-left tail), per spec.
    for (var i = 0; i < 15; i++) {
      var b = bit(i);
      if (i < 6) M.m[i][8] = b;
      else if (i < 8) M.m[i + 1][8] = b; // skip horizontal timing at row 6
      else M.m[size - 15 + i][8] = b;
    }
    // Copy 2 — horizontal strip in row 8 (and top-right tail), per spec.
    for (var j = 0; j < 15; j++) {
      var b2 = bit(j);
      if (j < 8) M.m[8][size - 1 - j] = b2;
      else if (j < 9) M.m[8][7] = b2; // skip vertical timing at col 6
      else M.m[8][14 - j] = b2;
    }
  }

  function bchVersion(v) {
    var d = v << 12;
    var g = 0b1111100100101;
    for (var i = 17; i >= 12; i--) {
      if ((d >> i) & 1) d ^= g << (i - 12);
    }
    return (v << 12) | d;
  }

  function placeVersion(M, v) {
    if (v < 7) return;
    var size = M.size;
    var bits = bchVersion(v); // 18 bits
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1 ? true : false;
      var r = Math.floor(i / 3);
      var c = i % 3;
      M.m[r][size - 11 + c] = bit;
      M.m[size - 11 + c][r] = bit;
    }
  }

  function penalty(M) {
    var size = M.size, score = 0, r, c, i;
    // Rule 1: runs of >=5 same color in rows/cols
    for (r = 0; r < size; r++) {
      var runC = 1;
      for (c = 1; c < size; c++) {
        if (M.m[r][c] === M.m[r][c - 1]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; }
        else runC = 1;
      }
    }
    for (c = 0; c < size; c++) {
      var runR = 1;
      for (r = 1; r < size; r++) {
        if (M.m[r][c] === M.m[r - 1][c]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; }
        else runR = 1;
      }
    }
    // Rule 2: 2x2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = M.m[r][c];
        if (v === M.m[r][c + 1] && v === M.m[r + 1][c] && v === M.m[r + 1][c + 1]) score += 3;
      }
    }
    // Rule 3: finder-like patterns
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(arr, pat) {
      for (var k = 0; k < pat.length; k++) if (arr[k] !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c < size - 10; c++) {
        var rowSeg = [], colSeg = [];
        for (i = 0; i < 11; i++) { rowSeg.push(M.m[r][c + i]); colSeg.push(M.m[c + i][r]); }
        if (matches(rowSeg, pat1) || matches(rowSeg, pat2)) score += 40;
        if (matches(colSeg, pat1) || matches(colSeg, pat2)) score += 40;
      }
    }
    // Rule 4: dark proportion
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (M.m[r][c]) dark++;
    var ratio = (dark * 100) / (size * size);
    var prev = Math.floor(Math.abs(ratio - 50) / 5);
    score += prev * 10;
    return score;
  }

  function buildBase(v) {
    var size = 17 + 4 * v;
    var M = makeMatrix(size);
    placeFinder(M, 0, 0);
    placeFinder(M, 0, size - 7);
    placeFinder(M, size - 7, 0);
    placeAlignment(M, v);
    placeTimingAndDark(M, v);
    reserveFormat(M);
    reserveVersion(M, v);
    return M;
  }

  function cloneModules(M) {
    var copy = makeMatrix(M.size);
    for (var r = 0; r < M.size; r++) {
      for (var c = 0; c < M.size; c++) {
        copy.m[r][c] = M.m[r][c];
        copy.fn[r][c] = M.fn[r][c];
      }
    }
    return copy;
  }

  function generate(text) {
    var bytes = [];
    var enc = unescape(encodeURIComponent(text)); // UTF-8
    for (var i = 0; i < enc.length; i++) bytes.push(enc.charCodeAt(i) & 0xff);

    var v = chooseVersion(bytes.length);
    var codewords = encodeData(bytes, v);
    var finalSeq = buildFinalSequence(codewords, v);
    var bits = [];
    for (var b = 0; b < finalSeq.length; b++) {
      for (var k = 7; k >= 0; k--) bits.push((finalSeq[b] >> k) & 1);
    }

    var base = buildBase(v);
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var M = cloneModules(base);
      placeData(M, bits, mask);
      placeFormat(M, mask);
      placeVersion(M, v);
      var p = penalty(M);
      if (p < bestScore) { bestScore = p; best = M; }
    }
    return best;
  }

  function toCanvas(canvas, text) {
    var M = generate(text);
    var size = M.size;
    var quiet = 4;
    var total = size + quiet * 2;
    var px = Math.max(1, Math.floor((canvas.width || 220) / total));
    var dim = px * total;
    canvas.width = dim;
    canvas.height = dim;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (M.m[r][c]) {
          ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
        }
      }
    }
  }

  window.QRCode = { toCanvas: toCanvas, generate: generate };
})();
