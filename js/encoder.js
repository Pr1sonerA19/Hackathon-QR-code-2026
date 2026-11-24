/* =====================================================================
   encoder.js  -  TEXT  ->  QR CODE   (the "how it's generated" half)
   =====================================================================

   The pipeline, in order. Each step is saved in the result so the web page
   can show what that stage produced:

     1. CHOOSE A MODE     numeric / alphanumeric / byte (smaller modes pack
                          the text tighter)
     2. TEXT -> BITS      mode indicator + character count + the data bits,
                          then a terminator and padding up to full capacity
     3. BITS -> BYTES     groups of 8 bits = "data codewords"
     4. ADD REPAIR BYTES  split into blocks, Reed-Solomon check bytes per block
     5. INTERLEAVE        mix the blocks' bytes together (spreads damage)
     6. PLACE IN GRID     write the bits along the zig-zag path
     7. MASK              try all 8 masks, keep the one with the lowest
                          "penalty" (fewest ugly patterns)
     8. FORMAT INFO       write the level + chosen mask next to the finders
   ===================================================================== */
(function () {
  "use strict";
  const QR = (window.QR = window.QR || {});
  const T = QR.Tables, L = QR.Layout, RS = QR.RS;

  const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

  /** Pick the most compact mode that can represent the text. */
  function chooseMode(text) {
    if (/^[0-9]+$/.test(text)) return "numeric";
    if (text.length > 0 && [...text].every((c) => ALNUM.includes(c))) return "alphanumeric";
    return "byte";
  }

  /** Append `len` bits of `value` (most significant first) to a bit array. */
  function pushBits(bits, value, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  /** How many bits the character-count field uses (depends on mode + version). */
  function countBits(mode, version) {
    const small = version <= 9; // versions 1-9 use the short field, 10+ the longer one
    if (mode === "numeric") return small ? 10 : 12;
    if (mode === "alphanumeric") return small ? 9 : 11;
    return small ? 8 : 16;
  }

  const MODE_BITS = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };

  /** The payload bits for the chosen mode. Returns { count, bits }. */
  function payload(text, mode) {
    const bits = [];
    if (mode === "numeric") {
      for (let i = 0; i < text.length; i += 3) {
        const chunk = text.substr(i, 3);          // 3 digits -> 10 bits, 2 -> 7, 1 -> 4
        pushBits(bits, parseInt(chunk, 10), chunk.length * 3 + 1);
      }
      return { count: text.length, bits };
    }
    if (mode === "alphanumeric") {
      for (let i = 0; i < text.length; i += 2) {
        if (i + 1 < text.length)                  // a pair of characters -> 11 bits
          pushBits(bits, ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
        else pushBits(bits, ALNUM.indexOf(text[i]), 6); // a lone character -> 6 bits
      }
      return { count: text.length, bits };
    }
    const bytes = Array.from(new TextEncoder().encode(text)); // UTF-8 so any language/emoji works
    for (const b of bytes) pushBits(bits, b, 8);
    return { count: bytes.length, bits };
  }

  /** Total penalty score of a masked grid (lower is better). From the QR standard. */
  function penalty(m, size) {
    let score = 0;
    // Rule 1: runs of 5+ same-coloured modules in a row/column
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < size; a++) {
        let run = 1, prev = pass === 0 ? m[a][0] : m[0][a];
        for (let b = 1; b < size; b++) {
          const cur = pass === 0 ? m[a][b] : m[b][a];
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
          else { run = 1; prev = cur; }
        }
      }
    // Rule 2: 2x2 blocks of one colour
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    // Rule 3: stripes that look like a finder square (1:1:3:1:1 with 4 light modules beside)
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < size; a++)
        for (let s = 0; s + 11 <= size; s++) {
          let m1 = true, m2 = true;
          for (let k = 0; k < 11 && (m1 || m2); k++) {
            const v = (pass === 0 ? m[a][s + k] : m[s + k][a]) ? 1 : 0;
            if (v !== p1[k]) m1 = false;
            if (v !== p2[k]) m2 = false;
          }
          if (m1) score += 40;
          if (m2) score += 40;
        }
    // Rule 4: balance of dark vs light (should be close to 50/50)
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  /**
   * MAIN FUNCTION.  encode("hello", "M")  ->  a result object (see bottom).
   * options.mask forces a mask 0..7 (otherwise the best one is chosen).
   * options.mode forces a mode.   options.minVersion forces a bigger code.
   */
  function encode(text, level, options) {
    options = options || {};
    if (!T.LEVELS.includes(level)) throw new Error("level must be L, M, Q or H");
    const mode = options.mode || chooseMode(text);
    const pl = payload(text, mode);

    // --- 1. smallest version where the data fits ---------------------------
    let version = 0, spec = null;
    for (let v = options.minVersion || 1; v <= T.MAX_VERSION; v++) {
      const s = T.blockSpec(v, level);
      if (4 + countBits(mode, v) + pl.bits.length <= s.totalData * 8) { version = v; spec = s; break; }
    }
    if (!version) {
      const best = T.blockSpec(T.MAX_VERSION, level).totalData;
      throw new Error("Too long for this demo (largest supported code holds about " + best + " bytes at level " + level + ").");
    }

    // --- 2. text -> bits ----------------------------------------------------
    const capacityBits = spec.totalData * 8;
    const bits = [];
    const segments = []; // for display: [{kind, bits:"0101..."}]
    const mark = (kind, from) => segments.push({ kind, bits: bits.slice(from).join("") });
    let at = 0;
    pushBits(bits, MODE_BITS[mode], 4); mark("mode", at); at = bits.length;
    pushBits(bits, pl.count, countBits(mode, version)); mark("count", at); at = bits.length;
    for (const b of pl.bits) bits.push(b); mark("data", at); at = bits.length;
    const term = Math.min(4, capacityBits - bits.length);       // terminator: up to 4 zero bits
    pushBits(bits, 0, term); if (term) mark("terminator", at); at = bits.length;
    const align = (8 - (bits.length % 8)) % 8;                  // pad to a whole byte
    pushBits(bits, 0, align); if (align) mark("padbits", at); at = bits.length;
    let padByte = 0xec, padCount = 0;                           // then alternate 11101100 / 00010001
    while (bits.length < capacityBits) { pushBits(bits, padByte, 8); padByte ^= 0xec ^ 0x11; padCount++; }
    if (padCount) mark("padbytes", at);

    // --- 3. bits -> data bytes ---------------------------------------------
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      dataCodewords.push(v);
    }

    // --- 4. split into blocks and add Reed-Solomon repair bytes -------------
    const blocks = [];
    let offset = 0;
    for (const len of spec.dataLens) {
      const data = dataCodewords.slice(offset, offset + len);
      offset += len;
      blocks.push({ data, ec: RS.encode(data, spec.ecLen) });
    }

    // --- 5. interleave -------------------------------------------------------
    const map = T.interleaveMap(spec);
    const codewords = map.map((m) => {
      const blk = blocks[m.block];
      return m.isEc ? blk.ec[m.index - blk.data.length] : blk.data[m.index];
    });

    // --- 6. place the bits along the zig-zag path ----------------------------
    const tpl = L.functionTemplate(version);
    const size = tpl.size;
    const positions = L.dataPositions(version, tpl.isFunction);
    const base = tpl.modules.map((r) => r.slice());
    // cwIndex[y][x] = which codeword (interleaved index) the module belongs to, -1 = none
    const cwIndex = L.makeGrid(size, -1);
    positions.forEach(([x, y], i) => {
      const k = i >> 3; // 8 bits per codeword
      if (k < codewords.length) {
        base[y][x] = ((codewords[k] >>> (7 - (i & 7))) & 1) === 1;
        cwIndex[y][x] = k;
      } // leftover "remainder" modules stay light
    });

    // --- 7. try all 8 masks ---------------------------------------------------
    const masked = [], penalties = [];
    for (let mk = 0; mk < 8; mk++) {
      const g = base.map((r) => r.slice());
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (!tpl.isFunction[y][x] && L.maskInvert(mk, x, y)) g[y][x] = !g[y][x];
      L.drawFormat(g, size, level, mk);   // --- 8. format info needs the mask number
      masked.push(g);
      penalties.push(penalty(g, size));
    }
    let mask = options.mask;
    if (mask === undefined || mask === null) mask = penalties.indexOf(Math.min(...penalties));

    return {
      text, mode, version, level, size,
      segments,              // the labelled bit-string pieces
      dataCodewords,         // bytes of the message (with padding)
      blocks,                // [{data:[...], ec:[...]}]
      spec,                  // {ecLen, dataLens, totalData, totalCw}
      interleaveMap: map,    // k -> {block, index, isEc}
      codewords,             // final byte stream written into the grid
      isFunction: tpl.isFunction,
      positions,             // zig-zag path
      cwIndex,               // module -> codeword index
      maskedGrids: masked,   // all 8 candidates
      penalties,
      mask,
      modules: masked[mask], // the finished code (true = dark)
    };
  }

  QR.Encoder = { encode, chooseMode, penalty, ALNUM };
})();
