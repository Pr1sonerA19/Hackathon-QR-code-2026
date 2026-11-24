/* =====================================================================
   layout.js  -  WHERE everything goes inside the QR grid
   =====================================================================

   A QR code is a square grid of dark/light "modules". Not all modules carry
   your message. Some are fixed "function patterns" that help the scanner:

     * 3 big FINDER squares (three corners): tell the scanner "this is a QR
       code" and which way up it is. Their 1:1:3:1:1 stripe ratio is easy to
       spot from any angle.
     * TIMING lines (row 6 and column 6, alternating dark/light): let the
       scanner measure the module size and spot bending/distortion.
     * ALIGNMENT squares (versions 2+): re-calibrate the grid in big codes.
     * FORMAT info (two copies, next to the finders): the repair level and
       the mask number (15 bits, itself protected by an error-correcting
       BCH code so it can survive damage).
     * VERSION info (versions 7+): the size, also BCH protected.
     * one always-dark module.

   Every OTHER module is a "data module" and carries one bit of the codeword
   stream (message bytes + repair bytes), laid down in a zig-zag path.

   This file is shared by the ENCODER (which writes bits along the path) and
   the DECODER (which reads them back along the same path).

   Coordinates: x = column (0 = left), y = row (0 = top). grid[y][x].
   ===================================================================== */
(function () {
  "use strict";
  const QR = (window.QR = window.QR || {});
  const T = QR.Tables;

  function sizeOf(version) { return 17 + 4 * version; }

  function makeGrid(size, fill) {
    return Array.from({ length: size }, () => new Array(size).fill(fill));
  }

  /** The BCH(15,5) code for the format bits. `data` is 5 bits: level(2) + mask(3). */
  function formatWord(level, mask) {
    const data = (T.FORMAT_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); // divide by 10100110111
    return ((data << 10) | rem) ^ 0x5412; // XOR with a fixed pattern so it is never all-zero
  }

  /** The BCH(18,6) code for the version number (versions 7+). */
  function versionWord(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  /** The (x, y) of each of the 15 format bits, for BOTH copies. */
  function formatPositions(size) {
    const a = []; // copy around the top-left finder
    for (let i = 0; i <= 5; i++) a.push([8, i]);
    a.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
    const b = []; // copy split between the top-right and bottom-left finders
    for (let i = 0; i < 8; i++) b.push([size - 1 - i, 8]);
    for (let i = 8; i < 15; i++) b.push([8, size - 15 + i]);
    return [a, b];
  }

  /** Write the 15 format bits (both copies) into a grid of booleans. */
  function drawFormat(grid, size, level, mask) {
    const word = formatWord(level, mask);
    const [a, b] = formatPositions(size);
    for (let i = 0; i < 15; i++) {
      const bit = ((word >>> i) & 1) === 1;
      grid[a[i][1]][a[i][0]] = bit;
      grid[b[i][1]][b[i][0]] = bit;
    }
    grid[size - 8][8] = true; // the always-dark module
  }

  /**
   * Build the empty "template": all the function patterns drawn, everything
   * else light. Returns { size, isFunction, modules }.
   */
  function functionTemplate(version) {
    const size = sizeOf(version);
    const modules = makeGrid(size, false);
    const isFunction = makeGrid(size, false);
    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };

    // Timing lines
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

    // Finder squares (7x7) plus their 1-module light "separator" ring => 9x9 area
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy)); // distance in "rings"
          setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // Alignment squares (5x5) - skipped where they would sit on a finder
    const pos = T.ALIGN[version - 1];
    const n = pos.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }

    // Reserve the format areas (real bits are written later, once the mask is chosen)
    drawFormat(modules, size, "L", 0);
    const [fa, fb] = formatPositions(size);
    for (const [x, y] of fa.concat(fb)) isFunction[y][x] = true;
    isFunction[size - 8][8] = true;

    // Version info (7+) is fixed for a given version, so draw it now
    if (version >= 7) {
      const word = versionWord(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((word >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setFn(a, b, bit);
        setFn(b, a, bit);
      }
    }
    return { size, isFunction, modules };
  }

  /**
   * The zig-zag PATH over all data modules, in the order bits are stored.
   * Start bottom-right, go up a 2-wide column, then down the next 2-wide
   * column, and so on, hopping over the vertical timing line (column 6) and
   * skipping function modules.
   */
  function dataPositions(version, isFunction) {
    const size = sizeOf(version);
    const out = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                       // column 6 is the timing line
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;       // direction alternates per column pair
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x]) out.push([x, y]);
        }
      }
    }
    return out;
  }

  /**
   * MASKING: to avoid big blank/solid areas and look-alikes of the finder
   * square (which confuse scanners), the encoder XORs data modules with one of
   * 8 fixed patterns. This returns true when module (x, y) gets flipped.
   */
  function maskInvert(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: throw new Error("mask must be 0..7");
    }
  }

  /** How many data bits a version holds in total (codeword bits + a few spare). */
  function rawDataModules(version) {
    let r = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const a = Math.floor(version / 7) + 2;
      r -= (25 * a - 10) * a - 55;
      if (version >= 7) r -= 36;
    }
    return r;
  }

  QR.Layout = {
    sizeOf, makeGrid, formatWord, versionWord, formatPositions, drawFormat,
    functionTemplate, dataPositions, maskInvert, rawDataModules,
  };
})();
