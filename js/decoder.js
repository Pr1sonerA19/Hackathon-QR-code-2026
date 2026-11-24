/* =====================================================================
   decoder.js  -  QR GRID  ->  TEXT   (and repairing damage on the way)
   =====================================================================

   This is the "scanner" half, working on a grid of dark/light modules that
   may have been damaged. (A real phone first has to find the code in a
   camera image and turn pixels into this grid; we skip that part and start
   from the grid, because the repair step is the interesting one.)

   Steps:
     1. SIZE -> VERSION          size = 17 + 4*version
     2. READ FORMAT INFO         two copies, each protected by a BCH code. We
                                 compare to all 32 valid words and take the
                                 closest (this can fix up to 3 wrong bits).
                                 It tells us the repair level and the mask.
     3. UNMASK + READ BITS       follow the same zig-zag path as the encoder
     4. SPLIT INTO BLOCKS        undo the interleaving
     5. REED-SOLOMON REPAIR      per block; may fix damaged bytes or give up
     6. READ THE MESSAGE         mode, length, characters
   ===================================================================== */
(function () {
  "use strict";
  const QR = (window.QR = window.QR || {});
  const T = QR.Tables, L = QR.Layout, RS = QR.RS, Enc = QR.Encoder;

  function popcount(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }

  /** Read both 15-bit format copies and match them to the nearest valid word. */
  function readFormat(grid, size) {
    const [pa, pb] = L.formatPositions(size);
    const read = (pos) => {
      let w = 0;
      for (let i = 0; i < 15; i++) if (grid[pos[i][1]][pos[i][0]]) w |= 1 << i;
      return w;
    };
    const copies = [read(pa), read(pb)];
    let best = null;
    for (const level of T.LEVELS)
      for (let mask = 0; mask < 8; mask++) {
        const word = L.formatWord(level, mask);
        for (let c = 0; c < 2; c++) {
          const dist = popcount(word ^ copies[c]);
          if (!best || dist < best.distance) best = { level, mask, distance: dist, copy: c };
        }
      }
    // A BCH(15,5) code with minimum distance 7 can correct up to 3 flipped bits.
    return best.distance <= 3 ? best : null;
  }

  /** Turn the repaired data bytes back into text. */
  function parseMessage(dataBytes, version) {
    const bits = [];
    for (const b of dataBytes) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
    let p = 0;
    const take = (n) => {
      if (p + n > bits.length) throw new Error("ran out of bits");
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | bits[p++];
      return v;
    };
    let text = "", mode = "";
    while (bits.length - p >= 4) {
      const m = take(4);
      if (m === 0) break; // terminator
      if (m === 1) {
        mode = "numeric";
        let n = take(version <= 9 ? 10 : 12);
        while (n >= 3) { text += String(take(10)).padStart(3, "0"); n -= 3; }
        if (n === 2) text += String(take(7)).padStart(2, "0");
        if (n === 1) text += String(take(4));
      } else if (m === 2) {
        mode = "alphanumeric";
        let n = take(version <= 9 ? 9 : 11);
        while (n >= 2) { const v = take(11); text += Enc.ALNUM[Math.floor(v / 45)] + Enc.ALNUM[v % 45]; n -= 2; }
        if (n === 1) text += Enc.ALNUM[take(6)];
      } else if (m === 4) {
        mode = "byte";
        const n = take(version <= 9 ? 8 : 16);
        const bytes = [];
        for (let i = 0; i < n; i++) bytes.push(take(8));
        text += new TextDecoder().decode(new Uint8Array(bytes));
      } else {
        throw new Error("unsupported data mode " + m);
      }
    }
    return { text, mode };
  }

  /**
   * MAIN FUNCTION.  decode(grid, {original})
   *   grid      array of rows of booleans (true = dark), possibly damaged
   *   original  (optional) the true interleaved codewords, so we can also
   *             report which bytes were REALLY damaged (used by the demo)
   */
  function decode(grid, options) {
    options = options || {};
    const size = grid.length;
    const out = { ok: false, reason: "", size };
    const version = (size - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > T.MAX_VERSION) {
      out.reason = "unsupported size";
      return out;
    }
    out.version = version;

    const fmt = readFormat(grid, size);
    if (!fmt) { out.reason = "the format information (next to the corner squares) is too damaged to read"; return out; }
    out.level = fmt.level; out.mask = fmt.mask; out.formatDistance = fmt.distance;

    const spec = T.blockSpec(version, fmt.level);
    out.spec = spec;
    const tpl = L.functionTemplate(version);
    const positions = L.dataPositions(version, tpl.isFunction);

    // read the bits (undoing the mask) and group them into bytes
    const raw = [];
    for (let k = 0; k < spec.totalCw; k++) {
      let v = 0;
      for (let b = 0; b < 8; b++) {
        const [x, y] = positions[k * 8 + b];
        const bit = grid[y][x] !== L.maskInvert(fmt.mask, x, y);
        v = (v << 1) | (bit ? 1 : 0);
      }
      raw.push(v);
    }
    out.rawCodewords = raw;

    // split into blocks (undo interleaving)
    const map = T.interleaveMap(spec);
    out.interleaveMap = map;
    const nBlocks = spec.dataLens.length;
    const blockBytes = spec.dataLens.map((len) => new Array(len + spec.ecLen).fill(0));
    map.forEach((m, k) => { blockBytes[m.block][m.index] = raw[k]; });

    // which bytes were really damaged (if we know the original)
    out.damagedIndices = [];
    if (options.original)
      raw.forEach((v, k) => { if (v !== options.original[k]) out.damagedIndices.push(k); });

    // repair each block
    out.blocks = [];
    const repaired = new Array(spec.totalCw);
    out.repairedIndices = []; // interleaved indices of bytes the decoder changed
    let allOk = true;
    for (let b = 0; b < nBlocks; b++) {
      const dec = RS.decode(blockBytes[b], spec.ecLen);
      const trueErrors = out.damagedIndices.filter((k) => map[k].block === b).length;
      out.blocks.push({
        ok: dec.ok, reason: dec.reason, syndromes: dec.syndromes, locator: dec.locator,
        errors: dec.errors, received: blockBytes[b], corrected: dec.corrected,
        capacity: Math.floor(spec.ecLen / 2), trueErrors, dataLen: spec.dataLens[b],
      });
      if (!dec.ok) allOk = false;
      map.forEach((m, k) => { if (m.block === b) repaired[k] = dec.corrected[m.index]; });
      if (dec.ok) for (const e of dec.errors) {
        const k = map.findIndex((m) => m.block === b && m.index === e.index);
        out.repairedIndices.push(k);
      }
    }
    out.fixedCodewords = repaired;
    if (!allOk) {
      const bad = out.blocks.findIndex((x) => !x.ok);
      out.reason = (nBlocks > 1 ? "block " + (bad + 1) : "the code") + " could not be repaired (" + out.blocks[bad].reason + ")";
      return out;
    }

    // put the repaired data bytes back in order and read the message
    const data = [];
    out.blocks.forEach((blk) => blk.corrected.slice(0, blk.dataLen).forEach((v) => data.push(v)));
    try {
      const msg = parseMessage(data, version);
      out.text = msg.text; out.mode = msg.mode; out.ok = true;
    } catch (e) {
      out.reason = "the repaired bytes do not form a valid message (" + e.message + ")";
    }
    return out;
  }

  QR.Decoder = { decode, readFormat, parseMessage };
})();
