/* =====================================================================
   ui.js  -  connects the page to the QR engine
   =====================================================================

   This file contains NO QR maths. It only:
     * asks QR.Encoder to build a code from the text,
     * lets the user damage the grid (a list of "edits" on top of the
       original modules),
     * asks QR.Decoder to read the damaged grid,
     * draws everything and writes the explanations.

   The most important idea in this file: the ORIGINAL code (state.enc.modules)
   is never changed. Damage lives in a separate array (state.edits). The grid
   shown on screen and handed to the decoder is "original + edits".
   ===================================================================== */
(function () {
  "use strict";
  const QR = window.QR;
  const T = QR.Tables, Enc = QR.Encoder, Dec = QR.Decoder, GF = QR.GF, RS = QR.RS;

  const QUIET = 4; // blank border (in modules) the standard requires around a code

  const state = {
    text: "Hello, judges! This QR code can repair itself.",
    level: "M",
    maskOverride: null,   // null = let the encoder choose the best mask
    enc: null,            // result of QR.Encoder.encode
    edits: null,          // Int8Array: -1 untouched, 0 forced light, 1 forced dark
    logo: null,           // {x, y, s} when the "logo" button was used (visual only)
    brush: "erase",
    radius: 3,
    showEc: false,
    showDamage: true,
    step: 1,
    placed: null,         // how many bytes are shown in step 4
    grid: null,           // current (damaged) grid
    dec: null,            // current decoder result
    damaged: [],          // interleaved indices of bytes that differ from the original
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);
  const hex = (b) => b.toString(16).toUpperCase().padStart(2, "0");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // small seeded random generator so the first stain is always the same
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------
     1. Building the code
     --------------------------------------------------------------- */
  function regenerate(keepEdits) {
    const err = $("error");
    if (state.text.length === 0) {
      err.textContent = "Type a message to put in the code.";
      err.hidden = false;
      return false;
    }
    try {
      const enc = Enc.encode(state.text, state.level, { mask: state.maskOverride });
      err.hidden = true;
      const sameSize = state.enc && state.enc.size === enc.size;
      state.enc = enc;
      if (!keepEdits || !sameSize || !state.edits) {
        state.edits = new Int8Array(enc.size * enc.size).fill(-1);
        state.logo = null;
      }
      state.placed = enc.codewords.length;
      return true;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return false;
    }
  }

  /** original modules with the user's edits applied on top */
  function currentGrid() {
    const enc = state.enc, n = enc.size;
    const g = new Array(n);
    for (let y = 0; y < n; y++) {
      g[y] = new Array(n);
      for (let x = 0; x < n; x++) {
        const e = state.edits[y * n + x];
        g[y][x] = e === -1 ? enc.modules[y][x] : e === 1;
      }
    }
    return g;
  }

  /** interleaved indices of bytes where at least one module differs from the original */
  function damagedBytes(grid) {
    const enc = state.enc, out = [];
    for (let k = 0; k < enc.codewords.length; k++) {
      for (let b = 0; b < 8; b++) {
        const [x, y] = enc.positions[k * 8 + b];
        if (grid[y][x] !== enc.modules[y][x]) { out.push(k); break; }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
     2. Drawing grids onto canvases
     --------------------------------------------------------------- */
  function moduleColor(enc, x, y, dark, ec) {
    if (!ec) return dark ? "#0b0f19" : "#ffffff";
    if (enc.isFunction[y][x]) return dark ? "#374151" : "#e5e7eb";   // corner squares, timing, format...
    const k = enc.cwIndex[y][x];
    if (k < 0) return dark ? "#374151" : "#f3f4f6";                  // spare "remainder" modules
    return enc.interleaveMap[k].isEc ? (dark ? "#c2410c" : "#fed7aa") : (dark ? "#1d4ed8" : "#bfdbfe");
  }

  /**
   * Draw a grid. opts: ec (colour by data/repair), quiet (border size),
   * limit (only show bytes < limit; others pale), overlay (fn to draw on top)
   */
  function paintGrid(cv, grid, opts) {
    opts = opts || {};
    const enc = state.enc, n = enc.size;
    const q = opts.quiet === undefined ? QUIET : opts.quiet;
    const dpr = window.devicePixelRatio || 1;
    const css = cv.clientWidth || 320;
    const px = Math.max(60, Math.round(css * dpr));
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    const ctx = cv.getContext("2d");
    const cell = px / (n + 2 * q);
    const edge = (i) => Math.round(i * cell);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let color;
        if (opts.limit !== undefined && !enc.isFunction[y][x] && !(enc.cwIndex[y][x] >= 0 && enc.cwIndex[y][x] < opts.limit))
          color = "#eef2f7";                                         // not placed yet
        else color = moduleColor(enc, x, y, grid[y][x], opts.ec);
        if (color === "#ffffff") continue;
        ctx.fillStyle = color;
        ctx.fillRect(edge(x + q), edge(y + q), edge(x + q + 1) - edge(x + q), edge(y + q + 1) - edge(y + q) + 0);
      }
    if (opts.overlay) opts.overlay(ctx, cell, q, edge);
  }

  function drawMain() {
    const enc = state.enc;
    paintGrid($("qr"), state.grid, {
      ec: state.showEc,
      overlay: (ctx, cell, q, edge) => {
        // tint the bytes that were damaged: amber = fixable, red = beyond repair
        if (state.showDamage) {
          for (const k of state.damaged) {
            const b = enc.interleaveMap[k].block;
            const blockOk = state.dec && state.dec.blocks ? state.dec.blocks[b].ok : false;
            ctx.fillStyle = blockOk ? "rgba(245,158,11,0.55)" : "rgba(220,38,38,0.6)";
            for (let i = 0; i < 8; i++) {
              const [x, y] = enc.positions[k * 8 + i];
              ctx.fillRect(edge(x + q), edge(y + q), edge(x + q + 1) - edge(x + q), edge(y + q + 1) - edge(y + q));
            }
          }
        }
        // the decorative logo (the modules under it were really wiped out)
        if (state.logo) {
          const { x, y, s } = state.logo;
          const px = edge(x + q), py = edge(y + q), size = edge(x + q + s) - px;
          ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#0f172a"; ctx.lineWidth = Math.max(2, cell * 0.25);
          const r = size * 0.18;
          ctx.beginPath();
          ctx.moveTo(px + r, py); ctx.arcTo(px + size, py, px + size, py + size, r); ctx.arcTo(px + size, py + size, px, py + size, r);
          ctx.arcTo(px, py + size, px, py, r); ctx.arcTo(px, py, px + size, py, r); ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#2563eb"; ctx.font = "bold " + Math.round(size * 0.6) + "px system-ui, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("★", px + size / 2, py + size / 2 + size * 0.04);
        }
      },
    });
    const dmgPct = state.damaged.length;
    $("qr").setAttribute("aria-label", "QR code, " + enc.size + " by " + enc.size + " modules. " +
      (dmgPct ? dmgPct + " bytes damaged. " : "Undamaged. ") + (state.dec && state.dec.ok ? "Still readable." : "Not readable."));
  }

  /* ---------------------------------------------------------------
     3. Damage tools
     --------------------------------------------------------------- */
  function setEdit(x, y, v) {
    const n = state.enc.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    state.edits[y * n + x] = v;
  }

  function paintAt(clientX, clientY) {
    const cv = $("qr"), enc = state.enc, n = enc.size;
    const rect = cv.getBoundingClientRect();
    const fx = ((clientX - rect.left) / rect.width) * (n + 2 * QUIET) - QUIET;
    const fy = ((clientY - rect.top) / rect.height) * (n + 2 * QUIET) - QUIET;
    const r = state.radius - 0.5;
    const value = state.brush === "erase" ? 0 : 1;
    for (let y = Math.floor(fy - r); y <= Math.ceil(fy + r); y++)
      for (let x = Math.floor(fx - r); x <= Math.ceil(fx + r); x++)
        if (Math.hypot(x + 0.5 - fx, y + 0.5 - fy) <= r + 0.5) setEdit(x, y, value);
  }

  /** a wobbly round blob that wipes modules out, like a coffee ring */
  function applyStain(cx, cy, radius, rng) {
    const n = state.enc.size;
    const ph = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const a = Math.atan2(dy, dx);
        const wobble = 1 + 0.25 * Math.sin(3 * a + ph[0]) + 0.15 * Math.sin(5 * a + ph[1]) + 0.1 * Math.sin(2 * a + ph[2]);
        if (Math.hypot(dx, dy) <= radius * wobble) setEdit(x, y, 0);
      }
  }

  function addStain() {
    const n = state.enc.size;
    applyStain(2 + Math.random() * (n - 4), 2 + Math.random() * (n - 4), n * (0.09 + Math.random() * 0.05), Math.random);
    requestUpdate();
  }

  function addScatter() {
    const n = state.enc.size, count = Math.ceil(n * n * 0.015);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * n), y = Math.floor(Math.random() * n);
      const e = state.edits[y * n + x];
      const current = e === -1 ? state.enc.modules[y][x] : e === 1;
      setEdit(x, y, current ? 0 : 1);
    }
    requestUpdate();
  }

  function addLogo() {
    const n = state.enc.size, s = Math.round(n * 0.24), x0 = Math.floor((n - s) / 2), y0 = Math.floor((n - s) / 2);
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) setEdit(x, y, 0);
    state.logo = { x: x0, y: y0, s };
    requestUpdate();
  }

  function resetDamage() {
    state.edits.fill(-1);
    state.logo = null;
    requestUpdate();
  }

  /** batch redraws so dragging stays smooth */
  function requestUpdate() {
    if (state.dirty) return;
    state.dirty = true;
    requestAnimationFrame(() => { state.dirty = false; update(); });
  }

  /* ---------------------------------------------------------------
     4. Decode + explain (runs on every change)
     --------------------------------------------------------------- */
  function update() {
    if (!state.enc) return;
    state.grid = currentGrid();
    state.damaged = damagedBytes(state.grid);
    state.dec = Dec.decode(state.grid, { original: state.enc.codewords });
    drawMain();
    renderVerdict();
    renderMeter();
    renderLearned();
    renderInternals();
  }

  function renderVerdict() {
    const enc = state.enc, dec = state.dec, el = $("verdict");
    const n = state.damaged.length;
    let cls, big, msg = "";
    if (dec.ok && dec.text === enc.text) {
      cls = "good";
      if (n === 0) { big = "✓ Readable — no damage yet"; msg = "Drag across the code to damage it."; }
      else { big = "✓ Recovered!"; msg = "The decoder repaired <b>" + dec.repairedIndices.length + " damaged byte" + (dec.repairedIndices.length === 1 ? "" : "s") + "</b> and read the message perfectly."; }
    } else if (dec.ok) {
      cls = "warn"; big = "⚠ Read the WRONG message";
      msg = "So much was damaged that the maths found a different valid code nearby. Real scanners add extra checks to avoid this.";
    } else {
      cls = "bad"; big = "✗ Can’t read it";
      msg = "The decoder gave up: " + esc(dec.reason) + ". It refuses to guess.";
    }
    el.className = "verdict " + cls;
    el.innerHTML = '<p class="big">' + big + "</p><p>" + msg + "</p>" +
      (dec.ok ? '<div class="decoded">&ldquo;' + esc(dec.text) + "&rdquo;</div>" : "");
  }

  function renderMeter() {
    const enc = state.enc, spec = enc.spec, el = $("meter");
    const per = new Array(spec.dataLens.length).fill(0);
    state.damaged.forEach((k) => per[enc.interleaveMap[k].block]++);
    const cap = Math.floor(spec.ecLen / 2);
    el.innerHTML = "";
    per.forEach((count, b) => {
      const row = document.createElement("div");
      row.className = "meter-row";
      const slots = Math.min(Math.max(cap, count), 40);
      let html = '<span class="name">' + (per.length > 1 ? "Block " + (b + 1) : "Repairs") + '</span><span class="slots">';
      for (let i = 0; i < slots; i++) html += '<i class="slot ' + (i < count ? (i < cap ? "used" : "over") : "") + '"></i>';
      html += '</span><span class="count' + (count > cap ? " over" : "") + '">' + count + " / " + cap + "</span>";
      row.innerHTML = html;
      el.appendChild(row);
    });
    const dm = countDamagedModules();
    const total = enc.size * enc.size;
    $("stats").innerHTML = "<b>" + dm + "</b> modules changed (" + (100 * dm / total).toFixed(1) + "% of the code) = <b>" +
      state.damaged.length + "</b> of " + enc.codewords.length + " bytes damaged. " +
      (per.length > 1 ? "Each of the " + per.length + " blocks can fix " + cap + " bytes, so damage spread across blocks is easier to survive. " : "") +
      "Eight modules make one byte, so a smudge costs fewer bytes than it has modules.";
  }

  function countDamagedModules() {
    const enc = state.enc, n = enc.size;
    let c = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (state.grid[y][x] !== enc.modules[y][x]) c++;
    return c;
  }

  function renderLearned() {
    const enc = state.enc, dec = state.dec, el = $("learned"), spec = enc.spec;
    const nBlocks = spec.dataLens.length, ecTotal = spec.ecLen * nBlocks;
    const cap = Math.floor(spec.ecLen / 2);
    if (state.damaged.length === 0) { el.hidden = true; return; }
    el.hidden = false;
    const pct = Math.round((100 * ecTotal) / spec.totalCw);
    if (dec.ok && dec.text === enc.text) {
      el.innerHTML = "<h3>Why it still worked</h3>" +
        "<p>This code holds <b>" + spec.totalData + " bytes</b> of message plus <b>" + ecTotal + " bytes</b> of Reed-Solomon repair data (" + pct + "% of the code). " +
        "Scratches destroyed some bytes, but the repair bytes are maths that describe what the message must have been.</p>" +
        "<p>The decoder checks whether the bytes fit that maths. Where they don&rsquo;t, it works out <i>which</i> bytes are wrong and <i>by how much</i>, and puts them right. " +
        "Level " + enc.level + " can fix up to <b>" + cap + " bytes in each block</b>. Try pushing past that.</p>";
    } else {
      el.innerHTML = "<h3>Why it stopped working</h3>" +
        "<p>Each repair byte pair can fix one damaged byte (one repair byte to find <i>where</i> it is, one to find <i>what</i> it should be). Past " + cap + " damaged bytes in a block, there isn&rsquo;t enough information to tell the damage from the message.</p>" +
        "<p>Try <b>Undo all damage</b>, then choose level H and repeat &mdash; more repair data means more damage survived, but a bigger, denser code.</p>";
    }
  }

  /* ---------------------------------------------------------------
     5. "How it's made" tabs
     --------------------------------------------------------------- */
  function renderStep() {
    const enc = state.enc, el = $("stepPanel");
    if (!enc) return;
    const spec = enc.spec;
    let html = "";
    if (state.step === 1) {
      const labels = { mode: "mode tag", count: "length", data: "your text", terminator: "end marker", padbits: "pad to whole byte", padbytes: "filler bytes" };
      const modeName = { numeric: "numeric (digits only: 10 bits per 3 digits)", alphanumeric: "alphanumeric (capitals and a few symbols: 11 bits per 2 characters)", byte: "byte (any text, stored as UTF-8: 8 bits per byte)" }[enc.mode];
      html = "<h3>Step 1 &middot; Text becomes bits</h3>" +
        "<p>The encoder picks the most compact <b>mode</b> that can hold your message: <b>" + modeName + "</b>. Then it writes a tag for the mode, the length, your characters, and finally padding so the code is exactly full. The code needed is <b>version " + enc.version + "</b> (" + enc.size + "&times;" + enc.size + " modules).</p>" +
        '<div class="bits">';
      enc.segments.forEach((s) => {
        let b = s.bits;
        if (b.length > 200) b = b.slice(0, 200) + "…";
        html += '<span class="seg seg-' + s.kind + '" title="' + labels[s.kind] + '">' + b + "</span> ";
      });
      html += '</div><div class="legend">' +
        '<span style="--c:#e9d5ff">mode tag</span><span style="--c:#fde68a">length</span><span style="--c:#dbeafe">your text</span>' +
        '<span style="--c:#e2e8f0">end marker / padding</span><span style="--c:#f1f5f9">filler bytes (11101100, 00010001 repeated)</span></div>';
    } else if (state.step === 2) {
      const bitsBeforeFiller = enc.segments.filter((s) => s.kind !== "padbytes").reduce((a, s) => a + s.bits.length, 0);
      const msgBytes = bitsBeforeFiller / 8;
      html = "<h3>Step 2 &middot; Bits are grouped into bytes</h3>" +
        "<p>Every 8 bits form one <b>byte</b> (shown in hexadecimal). The standard calls them <b>data codewords</b>. This code has room for exactly <b>" + spec.totalData + "</b> of them; your message used " + msgBytes + ", and the rest is filler.</p>" +
        '<div class="chips">';
      enc.dataCodewords.forEach((v, i) => { html += '<span class="chip' + (i >= msgBytes ? " pad" : "") + '">' + hex(v) + "</span>"; });
      html += "</div>";
    } else if (state.step === 3) {
      html = "<h3>Step 3 &middot; Repair bytes are added</h3>" +
        "<p>The data bytes are split into <b>" + spec.dataLens.length + " block" + (spec.dataLens.length > 1 ? "s" : "") + "</b>. For each block, Reed-Solomon maths produces <b>" + spec.ecLen + " repair bytes</b> (orange): the remainder when the block is divided by a fixed polynomial. " +
        "These repair bytes can fix up to <b>" + Math.floor(spec.ecLen / 2) + "</b> damaged bytes per block.</p>";
      enc.blocks.forEach((blk, i) => {
        html += '<div class="block-row"><h4>Block ' + (i + 1) + ": " + blk.data.length + " message bytes + " + blk.ec.length + ' repair bytes</h4><div class="chips">';
        blk.data.forEach((v) => { html += '<span class="chip">' + hex(v) + "</span>"; });
        blk.ec.forEach((v) => { html += '<span class="chip ec">' + hex(v) + "</span>"; });
        html += "</div></div>";
      });
      if (spec.dataLens.length > 1) {
        html += "<p>Then the blocks are <b>interleaved</b> (first byte of each block, then second byte of each, &hellip;; colours show the block). A scratch across neighbouring bytes now hurts several blocks a little instead of one block a lot.</p><div class=\"chips\">";
        enc.interleaveMap.slice(0, 48).forEach((m, k) => { html += '<span class="chip b' + (m.block % 8) + '">' + hex(enc.codewords[k]) + "</span>"; });
        html += (enc.codewords.length > 48 ? '<span class="chip pad">&hellip;</span>' : "") + "</div>";
      }
    } else if (state.step === 4) {
      html = "<h3>Step 4 &middot; Bytes are laid into the grid</h3>" +
        '<div class="place-wrap"><canvas id="placeCanvas" aria-label="Grid being filled in"></canvas><div>' +
        "<p>The three big corner squares, the dotted timing lines, and the small format areas are fixed (grey). Everything else is filled with the bytes, two modules wide, in a zig-zag starting at the <b>bottom right</b> and snaking up and down. Message bytes are <span style=\"color:#1d4ed8\"><b>blue</b></span>; repair bytes are <span style=\"color:#c2410c\"><b>orange</b></span>.</p>" +
        '<div class="slider-row"><label for="placeSlider">Bytes placed</label><input type="range" id="placeSlider" min="0" max="' + enc.codewords.length + '" value="' + state.placed + '"><b id="placeCount"></b></div>' +
        '<button type="button" id="placePlay">&#9654; Animate</button>' +
        "<p class=\"tiny\">Drag the slider to the end: the repair bytes are written last, so they fill the left-hand part of the code.</p></div></div>";
    } else {
      html = "<h3>Step 5 &middot; A mask is chosen</h3>" +
        "<p>If your data happened to make big solid areas, or stripes that look like a corner square, scanners could get confused. So the encoder flips modules using one of <b>8 fixed patterns</b> (masks). It tries all 8, scores each for ugly patterns (the <b>penalty</b>; lower is better), and keeps the best. The mask number is stored in the format info so the decoder can undo it. <b>Click a mask to try it:</b> the code on the left changes but the message does not.</p>" +
        '<div class="masks">';
      for (let m = 0; m < 8; m++)
        html += '<div class="mask-card' + (m === enc.mask ? " chosen" : "") + '" data-mask="' + m + '" tabindex="0" role="button" aria-label="Use mask ' + m + '"><canvas id="mask' + m + '"></canvas>' +
          '<span class="tag">Mask ' + m + (m === enc.mask ? " ✓" : "") + "</span>penalty " + enc.penalties[m] + "</div>";
      html += '</div><p><button type="button" id="maskAuto">Let the encoder choose again</button></p>';
    }
    el.innerHTML = html;

    // things that need the new elements to exist
    if (state.step === 4) {
      const slider = $("placeSlider"), draw = () => {
        state.placed = +slider.value;
        $("placeCount").textContent = state.placed + " / " + enc.codewords.length;
        paintGrid($("placeCanvas"), enc.modules, { ec: true, limit: state.placed, quiet: 1 });
      };
      slider.addEventListener("input", draw);
      draw();
      $("placePlay").addEventListener("click", () => {
        let k = 0;
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) { slider.value = enc.codewords.length; draw(); return; }
        const step = Math.max(1, Math.round(enc.codewords.length / 120));
        const tick = () => { k = Math.min(enc.codewords.length, k + step); slider.value = k; draw(); if (k < enc.codewords.length) requestAnimationFrame(tick); };
        tick();
      });
    }
    if (state.step === 5) {
      for (let m = 0; m < 8; m++) paintGrid($("mask" + m), enc.maskedGrids[m], { quiet: 1 });
      el.querySelectorAll(".mask-card").forEach((card) => {
        const choose = () => { state.maskOverride = +card.dataset.mask; if (regenerate(true)) { renderAll(); } };
        card.addEventListener("click", choose);
        card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
      });
      $("maskAuto").addEventListener("click", () => { state.maskOverride = null; if (regenerate(true)) renderAll(); });
    }
  }

  /* ---------------------------------------------------------------
     6. "Go deeper" panels
     --------------------------------------------------------------- */
  function polyTerm(c) { return c === 1 ? "1" : "α^" + GF.LOG[c]; }

  function renderInternals() {
    const dec = state.dec, el = $("internals");
    if (!dec) return;
    let html = "";
    if (dec.level) {
      html += "<p><b>Format info</b> (read from next to the corner squares): repair level <b>" + dec.level + "</b>, mask <b>" + dec.mask + "</b>. " +
        (dec.formatDistance ? "It had " + dec.formatDistance + " flipped bit" + (dec.formatDistance > 1 ? "s" : "") + " out of 15, which its own error-correcting code fixed." : "All 15 bits matched a valid word.") + "</p>";
    } else {
      html += "<p><b>Format info:</b> " + esc(dec.reason) + " (it tolerates up to 3 wrong bits out of 15).</p>";
    }
    if (dec.blocks) {
      dec.blocks.forEach((b, i) => {
        html += '<div class="internal-block"><h4>Block ' + (i + 1) + " &middot; " + (b.ok ? (b.errors.length ? "repaired" : "clean") : "gave up") + "</h4>";
        html += "<p><b>Syndromes</b> (the block evaluated at &alpha;<sup>0</sup>, &alpha;<sup>1</sup>, &hellip;): <span class=\"mono\">" + b.syndromes.map(hex).join(" ") + "</span><br>" +
          (b.syndromes.every((s) => s === 0) ? "All zero means the block is a valid codeword: nothing to fix." : "Non-zero means something is wrong. The pattern of numbers encodes where and what.") + "</p>";
        const L = b.locator.length - 1;
        if (L > 0) {
          html += "<p><b>Error locator</b> &Lambda;(x) = " + b.locator.map((c, p) => (c === 0 ? "" : polyTerm(c) + (p ? "·x" + (p > 1 ? "^" + p : "") : ""))).filter(Boolean).join(" + ") +
            "<br>Degree " + L + " &rarr; the decoder believes <b>" + L + " byte" + (L > 1 ? "s are" : " is") + " wrong</b> (it can handle up to " + b.capacity + ").</p>";
        }
        if (b.ok && b.errors.length) {
          html += "<p><b>Repairs:</b> " + b.errors.map((e) => "byte #" + e.index + ": <span class=\"mono\">" + hex(e.was) + " &rarr; " + hex(e.now) + "</span>").join(", ") + "</p>";
        } else if (!b.ok) {
          html += "<p><b>Result:</b> " + esc(b.reason) + ".</p>";
        }
        html += "</div>";
      });
    }
    el.innerHTML = html;
  }

  function renderGf() {
    const a = Math.max(0, Math.min(255, parseInt($("gfA").value, 10) || 0));
    const b = Math.max(0, Math.min(255, parseInt($("gfB").value, 10) || 0));
    const bin = (v) => v.toString(2).padStart(8, "0");
    let out = "a + b   =  a XOR b\n        " + bin(a) + "\n    XOR " + bin(b) + "\n      = " + bin(a ^ b) + "  = " + (a ^ b) + "\n\na × b\n";
    if (a === 0 || b === 0) out += "  anything times 0 is 0";
    else out += "  log(a) = " + GF.LOG[a] + "   log(b) = " + GF.LOG[b] + "\n  " + GF.LOG[a] + " + " + GF.LOG[b] + " = " + (GF.LOG[a] + GF.LOG[b]) +
      "   (mod 255 = " + ((GF.LOG[a] + GF.LOG[b]) % 255) + ")\n  α^" + ((GF.LOG[a] + GF.LOG[b]) % 255) + " = " + GF.mul(a, b) + "   <- the product";
    $("gfOut").textContent = out;
  }

  function renderGenerator() {
    const ecLen = state.enc.spec.ecLen, g = RS.generator(ecLen);
    $("genPoly").textContent = "degree " + ecLen + " (one factor per repair byte):\n" +
      g.map((c, i) => polyTerm(c) + "·x^" + (ecLen - i)).join(" + ").replace(/·x\^0$/, "");
  }

  function renderCapacity() {
    let html = "<tr><th>Version</th><th>Size</th>" + T.LEVELS.map((l) => "<th>" + l + " (~" + T.LEVEL_INFO[l].approx + "%)</th>").join("") + "</tr>";
    for (let v = 1; v <= T.MAX_VERSION; v++) {
      html += "<tr><td>" + v + "</td><td>" + (17 + 4 * v) + "&times;" + (17 + 4 * v) + "</td>";
      for (const l of T.LEVELS) {
        const s = T.blockSpec(v, l), cb = v <= 9 ? 8 : 16;
        html += "<td>" + Math.floor((s.totalData * 8 - 4 - cb) / 8) + "</td>";
      }
      html += "</tr>";
    }
    $("capTable").innerHTML = html;
  }

  /* ---------------------------------------------------------------
     7. Wiring everything up
     --------------------------------------------------------------- */
  function renderAll() {
    update();
    renderStep();
    renderGenerator();
  }

  function setCaption(text) { $("caption").textContent = text; }

  function init() {
    $("text").addEventListener("input", (e) => {
      state.text = e.target.value; state.maskOverride = null;
      if (regenerate(false)) { renderAll(); setCaption("Drag across the code with your mouse or finger to damage it."); }
    });
    document.querySelectorAll('input[name="level"]').forEach((r) => r.addEventListener("change", () => {
      state.level = r.value; state.maskOverride = null;
      if (regenerate(false)) { renderAll(); setCaption("New repair level, new code. Damage it again to compare."); }
    }));
    document.querySelectorAll('input[name="brush"]').forEach((r) => r.addEventListener("change", () => { state.brush = r.value; }));
    $("radius").addEventListener("input", (e) => { state.radius = +e.target.value; });
    $("showEc").addEventListener("change", (e) => { state.showEc = e.target.checked; drawMain(); });
    $("showDamage").addEventListener("change", (e) => { state.showDamage = e.target.checked; drawMain(); });
    $("btnStain").addEventListener("click", addStain);
    $("btnScatter").addEventListener("click", addScatter);
    $("btnLogo").addEventListener("click", addLogo);
    $("btnReset").addEventListener("click", () => { resetDamage(); setCaption("All damage removed."); });

    // painting with mouse / finger / pen
    const cv = $("qr");
    let painting = false;
    cv.addEventListener("pointerdown", (e) => {
      painting = true; cv.setPointerCapture(e.pointerId);
      paintAt(e.clientX, e.clientY); requestUpdate();
      setCaption("Keep going — watch the repair budget fill up on the right.");
    });
    cv.addEventListener("pointermove", (e) => { if (painting) { paintAt(e.clientX, e.clientY); requestUpdate(); } });
    const stop = () => { painting = false; };
    cv.addEventListener("pointerup", stop);
    cv.addEventListener("pointercancel", stop);

    // tabs
    document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => {
      state.step = +btn.dataset.step;
      document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      renderStep();
    }));

    $("gfA").addEventListener("input", renderGf);
    $("gfB").addEventListener("input", renderGf);
    window.addEventListener("resize", () => { if (state.enc) { drawMain(); if (state.step >= 4) renderStep(); } });

    renderCapacity();
    renderGf();

    if (!regenerate(false)) return;

    // Start already smudged, so a first-time visitor sees the point at once.
    // (If the default stain were ever too strong we shrink it until it recovers.)
    const n = state.enc.size;
    let r = n * 0.1;
    for (let tries = 0; tries < 8; tries++) {
      state.edits.fill(-1);
      applyStain(n * 0.62, n * 0.6, r, mulberry32(7));
      const dec = Dec.decode(currentGrid());
      if (dec.ok) break;
      r *= 0.85;
    }
    renderAll();
    setCaption("We smudged this code before you arrived — and it still reads. Drag across it to make it worse.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
