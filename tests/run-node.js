/* Run with:  node tests/run-node.js
   Loads the same classic <script> files the browser uses, then runs checks. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, TextEncoder, TextDecoder };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["gf256", "reedsolomon", "tables", "layout", "encoder", "decoder"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f + ".js"), "utf8"), ctx, { filename: f + ".js" });
}
const QR = ctx.QR;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; } else { fail++; console.log("FAIL:", name, extra === undefined ? "" : extra); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. GF(256) -----------------------------------------------------------
check("exp[8] = 0x1d", QR.GF.EXP[8] === 0x1d);
check("2*128 = 0x1d", QR.GF.mul(2, 128) === 0x1d);
let okInv = true;
for (let a = 1; a < 256; a++) if (QR.GF.mul(a, QR.GF.inv(a)) !== 1) okInv = false;
check("every nonzero has an inverse", okInv);
let seen = new Set();
for (let i = 0; i < 255; i++) seen.add(QR.GF.EXP[i]);
check("alpha generates all 255 nonzero values", seen.size === 255 && !seen.has(0));

// ---- 2. Block table sanity: data + ec = raw capacity ---------------------
for (let v = 1; v <= QR.Tables.MAX_VERSION; v++) {
  const tpl = QR.Layout.functionTemplate(v);
  const positions = QR.Layout.dataPositions(v, tpl.isFunction);
  check("v" + v + " positions = raw modules", positions.length === QR.Layout.rawDataModules(v));
  for (const lv of QR.Tables.LEVELS) {
    const s = QR.Tables.blockSpec(v, lv);
    const cap = Math.floor(positions.length / 8);
    check("v" + v + lv + " total codewords", s.totalCw === cap, s.totalCw + " vs " + cap);
  }
}

// ---- 3. Known test vector: "HELLO WORLD" (alphanumeric) ------------------
let e = QR.Encoder.encode("HELLO WORLD", "Q");
check("HELLO WORLD is version 1", e.version === 1);
check("HELLO WORLD data codewords", eq(e.dataCodewords, [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236]), JSON.stringify(e.dataCodewords));
check("HELLO WORLD EC codewords (1-Q)", eq(e.blocks[0].ec, [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]), JSON.stringify(e.blocks[0].ec));
e = QR.Encoder.encode("HELLO WORLD", "M");
check("HELLO WORLD EC codewords (1-M)", eq(e.blocks[0].ec, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]), JSON.stringify(e.blocks[0].ec));
// numeric example from the spec: 01234567, version 1-M
e = QR.Encoder.encode("01234567", "M");
check("01234567 data codewords", eq(e.dataCodewords.slice(0, 5), [16, 32, 12, 86, 97]), JSON.stringify(e.dataCodewords.slice(0, 5)));

// ---- 4. Format info known values -----------------------------------------
check("format word L mask 4 = 110011000101111", QR.Layout.formatWord("L", 4) === 0b110011000101111, QR.Layout.formatWord("L", 4).toString(2));
check("format word M mask 0 = 101010000010010", QR.Layout.formatWord("M", 0) === 0b101010000010010, QR.Layout.formatWord("M", 0).toString(2));
check("version 7 word = 000111110010010100", QR.Layout.versionWord(7) === 0b000111110010010100, QR.Layout.versionWord(7).toString(2));

// ---- 5. Round trip: encode -> decode, many texts/levels/masks -------------
const samples = ["a", "Hello, world!", "https://example.com/qr?x=1&y=2", "0123456789012345", "HELLO WORLD 123",
  "Ünïcödé ✓ 日本語 🙂", "x".repeat(150), "The quick brown fox jumps over the lazy dog. ".repeat(3)];
for (const text of samples)
  for (const lv of QR.Tables.LEVELS)
    for (const mask of [undefined, 0, 3, 7]) {
      let enc;
      try { enc = QR.Encoder.encode(text, lv, { mask }); } catch (err) { continue; }
      const dec = QR.Decoder.decode(enc.modules, { original: enc.codewords });
      check("roundtrip " + lv + " " + text.slice(0, 12) + " m" + mask, dec.ok && dec.text === text && dec.mask === enc.mask && dec.level === lv, dec.reason);
    }

// ---- 6. Fuzz Reed-Solomon directly ----------------------------------------
function rnd(n) { return Math.floor(Math.random() * n); }
let fuzzBad = 0, fuzzRuns = 0, tooMany = { detected: 0, wrongOk: 0 };
for (let t = 0; t < 3000; t++) {
  const ecLen = [7, 10, 13, 16, 18, 22, 28, 30][rnd(8)];
  const dataLen = 9 + rnd(100);
  const data = Array.from({ length: dataLen }, () => rnd(256));
  const block = data.concat(QR.RS.encode(data, ecLen));
  const cap = Math.floor(ecLen / 2);
  const nErr = rnd(cap + 1);                 // 0 .. cap errors: MUST be repaired
  const bad = block.slice();
  const idx = new Set();
  while (idx.size < nErr) idx.add(rnd(block.length));
  for (const i of idx) bad[i] ^= 1 + rnd(255);
  const r = QR.RS.decode(bad, ecLen);
  fuzzRuns++;
  if (!r.ok || !eq(r.corrected, block)) { fuzzBad++; if (fuzzBad < 4) console.log("fuzz fail", { ecLen, dataLen, nErr }, r.reason); }
}
check("RS repairs every case within capacity (" + fuzzRuns + " random trials)", fuzzBad === 0, fuzzBad + " failures");
// beyond capacity: must usually be DETECTED as failure (never silently "ok" with wrong data is rare but possible)
for (let t = 0; t < 2000; t++) {
  const ecLen = 10, data = Array.from({ length: 30 }, () => rnd(256));
  const block = data.concat(QR.RS.encode(data, ecLen));
  const bad = block.slice();
  const idx = new Set();
  while (idx.size < 8) idx.add(rnd(block.length));
  for (const i of idx) bad[i] ^= 1 + rnd(255);
  const r = QR.RS.decode(bad, ecLen);
  if (!r.ok) tooMany.detected++; else if (!eq(r.corrected, block)) tooMany.wrongOk++;
}
console.log("beyond capacity (8 errors, cap 5): detected", tooMany.detected, "/2000, silently wrong", tooMany.wrongOk);
check("beyond-capacity mostly detected", tooMany.detected > 1900);

// ---- 7. Damage a whole QR within/over the limit -----------------------------
{
  const enc = QR.Encoder.encode("Damage test: this must survive!", "H");
  const t = Math.floor(enc.spec.ecLen / 2);
  // corrupt t whole bytes in each block by flipping all their modules
  const g = enc.modules.map((r) => r.slice());
  const hit = new Array(enc.spec.dataLens.length).fill(0);
  for (let k = 0; k < enc.codewords.length; k++) {
    const b = enc.interleaveMap[k].block;
    if (hit[b] < t && k % 3 === 0) {
      hit[b]++;
      enc.positions.slice(k * 8, k * 8 + 8).forEach(([x, y]) => { g[y][x] = !g[y][x]; });
    }
  }
  const dec = QR.Decoder.decode(g, { original: enc.codewords });
  check("QR survives t damaged bytes per block", dec.ok && dec.text === enc.text, dec.reason);
  // now one more per block
  const g2 = g.map((r) => r.slice());
  for (let b = 0; b < hit.length; b++) {
    for (let k = 0; k < enc.codewords.length; k++) {
      if (enc.interleaveMap[k].block === b && k % 3 !== 0) {
        enc.positions.slice(k * 8, k * 8 + 8).forEach(([x, y]) => { g2[y][x] = !g2[y][x]; });
        break;
      }
    }
  }
  const dec2 = QR.Decoder.decode(g2, { original: enc.codewords });
  check("QR fails (not silently wrong) at t+1 per block", !dec2.ok || dec2.text !== enc.text);
  console.log("  at t+1:", dec2.ok ? "decoded (wrong text?) " + (dec2.text === enc.text) : "failed: " + dec2.reason);
}

// ---- 8. Export some codes for scanning with an external reader -------------
const out = {};
for (const [name, text, lv] of [["a", "Hello, QR hackathon!", "M"], ["b", "HELLO WORLD", "Q"], ["c", "https://example.com/qr-demo?lang=en", "H"], ["d", "0123456789", "L"], ["e", "A fairly long message to push the code to a larger version: ".repeat(2), "Q"], ["f", "日本語のテキスト 🙂", "M"]]) {
  const enc = QR.Encoder.encode(text, lv);
  out[name] = { text, level: lv, version: enc.version, grid: enc.modules.map((r) => r.map((v) => (v ? 1 : 0))) };
}
fs.writeFileSync(path.join(__dirname, "export.json"), JSON.stringify(out));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
