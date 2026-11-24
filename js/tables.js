/* =====================================================================
   tables.js  -  The fixed numbers from the QR standard (ISO/IEC 18004)
   =====================================================================

   A QR code is not free-form: the standard dictates, for every size
   ("version") and every repair level, exactly how many data bytes it holds
   and how those bytes are chopped into blocks. We need those numbers to
   build a code that real phone scanners accept. We support versions 1-10
   (21x21 up to 57x57 modules), which is plenty for text and short links.

   VERSION    -> size in modules = 17 + 4 * version
   REPAIR LEVEL (L, M, Q, H) -> roughly 7%, 15%, 25%, 30% of the bytes can be
   wrong and the code still decodes.

   Why BLOCKS? Reed-Solomon over GF(256) works on blocks of at most 255
   bytes, and splitting a big message into several blocks also spreads
   damage out: each block has its own repair budget.
   ===================================================================== */
(function () {
  "use strict";
  const QR = (window.QR = window.QR || {});

  const LEVELS = ["L", "M", "Q", "H"];

  // The 2-bit code the standard uses for each level inside the "format info".
  // (Yes, the order is odd: L=01, M=00, Q=11, H=10.)
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  const LEVEL_INFO = {
    L: { name: "Low", approx: 7 },
    M: { name: "Medium", approx: 15 },
    Q: { name: "Quartile", approx: 25 },
    H: { name: "High", approx: 30 },
  };

  // BLOCK_TABLE[version-1][levelIndex] = [ecBytesPerBlock, n1, dataLen1, n2, dataLen2]
  //   n1 blocks that each carry dataLen1 data bytes, then n2 blocks of dataLen2.
  // Order of levels: L, M, Q, H.
  const BLOCK_TABLE = [
    /* v1  */ [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
    /* v2  */ [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
    /* v3  */ [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
    /* v4  */ [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
    /* v5  */ [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
    /* v6  */ [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
    /* v7  */ [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
    /* v8  */ [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
    /* v9  */ [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
    /* v10 */ [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
  ];

  const MAX_VERSION = BLOCK_TABLE.length;

  /**
   * blockSpec(version, level) describes how the codewords are organised:
   *   ecLen      check bytes in EVERY block
   *   dataLens   data bytes in each block, e.g. [15, 15, 16, 16]
   *   totalData  all data bytes
   *   totalCw    data + check bytes = the whole capacity of the code
   */
  function blockSpec(version, level) {
    const row = BLOCK_TABLE[version - 1][LEVELS.indexOf(level)];
    const ecLen = row[0];
    const dataLens = [];
    for (let i = 0; i < row[1]; i++) dataLens.push(row[2]);
    for (let i = 0; i < row[3]; i++) dataLens.push(row[4]);
    const totalData = dataLens.reduce((a, b) => a + b, 0);
    return { ecLen, dataLens, totalData, totalCw: totalData + ecLen * dataLens.length };
  }

  /**
   * The standard INTERLEAVES the blocks: byte 0 of every block, then byte 1 of
   * every block, ... then the same for the check bytes. That way a single
   * scratch that wipes out a run of neighbouring bytes hits many different
   * blocks a little, instead of one block a lot.
   *
   * interleaveMap returns an array where entry k describes the k-th byte as
   * it appears in the finished code: { block, index } where `index` is its
   * position inside that block's [data..., check...] array.
   */
  function interleaveMap(spec) {
    const map = [];
    const maxData = Math.max(...spec.dataLens);
    for (let i = 0; i < maxData; i++)
      for (let b = 0; b < spec.dataLens.length; b++)
        if (i < spec.dataLens[b]) map.push({ block: b, index: i, isEc: false });
    for (let i = 0; i < spec.ecLen; i++)
      for (let b = 0; b < spec.dataLens.length; b++)
        map.push({ block: b, index: spec.dataLens[b] + i, isEc: true });
    return map;
  }

  /** Centre coordinates of the small "alignment" squares for a version. */
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  QR.Tables = { LEVELS, FORMAT_BITS, LEVEL_INFO, BLOCK_TABLE, MAX_VERSION, blockSpec, interleaveMap, ALIGN };
})();
