# Code walkthrough: what every part does and why it is needed

Read this in order. Each section says **what** the code does and **why** it has to exist.
The code itself also has plain-English comments.

## 0. The big picture

A QR code is a grid of dark and light squares ("modules"). The page does two jobs:

1. **Encode** (`encoder.js`): turn text into a grid.
2. **Decode** (`decoder.js`): turn a (possibly damaged) grid back into text, repairing damage on the way.

The key idea we are explaining: before drawing the grid, the encoder adds **repair bytes**
computed with **Reed-Solomon** maths. The decoder uses them to find and fix damaged bytes.

The files share one global object, `window.QR`, instead of using modules. **Why:** browsers
refuse to load JavaScript modules when you open a page by double-clicking it, and we want it to
work that way as well as on a web server.

Files must be loaded in this order (see the bottom of `index.html`), because each uses the earlier ones:
`gf256` then `reedsolomon` then `tables` then `layout` then `encoder` then `decoder` then `ui`.

---

## 1. `js/gf256.js`: arithmetic on bytes

**What.** Builds two lookup tables, `EXP` and `LOG`, and defines add, multiply, divide, power, inverse.

**Why.** Reed-Solomon needs to add, multiply and divide *bytes* and always get a *byte* back.
Normal arithmetic can't do that (255 + 1 = 256 is not a byte). The field **GF(256)** can:

* **Add = XOR** (`a ^ b`). No carrying, and adding a number to itself gives 0.
* **Multiply = add the logarithms.** We pick the number alpha = 2. Every non-zero byte is
  alpha to some power. `EXP[n]` is alpha^n and `LOG[x]` is the n. So `a * b = EXP[LOG[a] + LOG[b]]`.
* The tables are built by starting at 1 and doubling. Whenever the value reaches 256 or more
  we XOR with `0x11D`. That number is the QR standard's "primitive polynomial"
  (x^8 + x^4 + x^3 + x^2 + 1), and doing so makes the doubling visit all 255 non-zero bytes
  exactly once before repeating.
* `EXP` is stored twice over (512 entries) so adding two logs never needs a `% 255`.

---

## 2. `js/reedsolomon.js`: adding repair bytes, finding and fixing damage

### Encoding: `generator()` and `encode()`

* A block of message bytes is treated as a **polynomial** (the bytes are the coefficients).
* The **generator polynomial** `g(x) = (x - a^0)(x - a^1)...(x - a^(n-1))` has `n` roots, where
  `n` is the number of repair bytes. `generator(n)` builds it by multiplying out the factors.
* `encode(data, n)` divides `data * x^n` by `g(x)` and returns the **remainder**: those are the
  repair bytes. **Why this works:** appending the remainder makes the whole block exactly divisible
  by `g(x)`, so the finished block evaluates to zero at a^0 ... a^(n-1).

### Decoding: `syndromes()`, `berlekampMassey()`, then Chien search and Forney in `decode()`

1. **Syndromes.** Evaluate the received block at a^0 ... a^(n-1). For an undamaged block all
   results are zero. Non-zero results mean damage, and the *pattern* of them encodes where it is
   and how big it is. If all are zero we return immediately.
2. **Berlekamp-Massey** turns the syndromes into the **error locator polynomial**. Its degree
   is the number of damaged bytes it believes there are, and its roots point at their positions.
   If that number is more than `n / 2` we stop: **why** the limit is `n / 2`: each error has two
   unknowns (where and what), and each repair byte gives one equation.
3. **Chien search.** Try every position; the ones where the locator polynomial evaluates to zero
   are the damaged positions. If we don't find exactly as many as the degree says, the damage
   pattern is not a valid repairable one, so we fail.
4. **Forney algorithm.** Computes the **size** of each error. XOR that onto the damaged byte to repair it.
5. **Safety check.** After repairing, recompute the syndromes. If they are not all zero we report
   failure instead of returning wrong data.

`decode()` returns not just the fixed block but also the syndromes, locator polynomial and list of
repairs, because the page shows them in "Inside the decoder".

---

## 3. `js/tables.js`: the fixed numbers from the standard

**What.** `BLOCK_TABLE` says, for each version (1 to 10) and repair level (L, M, Q, H), how many
repair bytes each block has and how many blocks of which size there are. Also the alignment-square
positions, the 2-bit level codes, and two helpers:

* `blockSpec(version, level)`: repair bytes per block, list of data bytes per block, totals.
* `interleaveMap(spec)`: the order in which bytes from the different blocks are mixed together.

**Why.** A phone scanner only reads codes that follow the standard exactly, so these numbers can't
be invented. (Our tests check that data bytes + repair bytes equal the grid's real capacity for
every version and level.) **Why blocks and interleaving:** Reed-Solomon over bytes works in blocks of
at most 255 bytes, and mixing the blocks' bytes spreads a local scratch over many blocks, so no
single block is overwhelmed.

---

## 4. `js/layout.js`: where everything sits in the grid

**What.** Everything about geometry:

* `functionTemplate(version)`: draws the **fixed patterns** and records which modules they occupy:
  three **finder squares** (corners; they tell the scanner "this is a QR code" and which way up),
  **timing lines** (dotted row and column 6; they let the scanner measure module size),
  **alignment squares** (bigger codes), **format info** areas and **version info** (versions 7+).
* `formatWord()` / `versionWord()`: compute the format and version bits using BCH codes
  (small error-correcting codes of their own, so even this information survives damage).
* `dataPositions()`: the **zig-zag path** over every non-fixed module: start bottom-right, go up a
  two-wide column, down the next, hop over the timing column, and so on.
* `maskInvert()`: the eight **mask patterns**.

**Why in its own file.** The encoder *writes* bits along the path and the decoder *reads* them back
along the same path. Sharing one definition guarantees they agree.

---

## 5. `js/encoder.js`: text to QR code

`encode(text, level)` goes through these stages. Each one is saved in the result so the page can display it:

1. **Choose a mode.** Digits only: numeric (10 bits per 3 digits). Capitals and a few symbols:
   alphanumeric (11 bits per 2 characters). Anything else: byte mode (UTF-8, so any language
   or emoji works). **Why:** smaller modes fit more text into the same code.
2. **Choose the smallest version** whose data capacity holds the text.
3. **Text to bits:** 4-bit mode tag, character count, the data, then a terminator (up to four 0s),
   padding to a whole byte, and filler bytes `11101100` / `00010001` until the code is exactly full.
4. **Bits to bytes** (the "data codewords").
5. **Split into blocks and add repair bytes** by calling `RS.encode` for each block.
6. **Interleave** the blocks using `interleaveMap`.
7. **Place the bits** in the grid along the zig-zag path. We also remember which byte each module
   belongs to (`cwIndex`); the page uses this to colour message vs repair bytes and to tint damaged bytes.
8. **Masking.** All 8 masks are applied; each result gets a **penalty score** (runs of the same colour,
   2x2 blocks, look-alikes of the finder square, imbalance of dark and light), and the lowest wins.
   **Why:** big blank areas or false finder squares confuse scanners.
9. **Write the format info** (repair level and mask number) beside the finder squares.

---

## 6. `js/decoder.js`: damaged grid to text

`decode(grid)` reverses the process:

1. **Size to version** (`size = 17 + 4 * version`).
2. **Read the format info.** There are two copies. We compare them with all 32 valid format words
   and take the closest. The code can correct up to 3 wrong bits out of 15. This gives the repair
   level and the mask. If it is too damaged we stop: without the mask we can't read the data.
3. **Read the bits** along the zig-zag path, undoing the mask, and group them into bytes.
4. **Undo the interleaving** to get the blocks back.
5. **Repair each block** with `RS.decode`. Every block must succeed.
6. **Read the message** from the repaired data bytes (mode, length, characters).

It also reports details for the page: which bytes were repaired, and, per block, the syndromes and locator polynomial.

---

## 7. `js/ui.js`: the page

This file contains **no QR maths**; it only connects the engine to the screen.

* **Original and damage are kept apart.** `state.enc.modules` is the true code and never changes. The
  user's damage is a separate array `state.edits` (-1 untouched, 0 forced light, 1 forced dark). The
  grid on screen and passed to the decoder is the original with the edits applied.
* **Damage tools.** Painting converts the pointer position to a module position and forces the modules
  in a small circle. *Coffee stain* wipes a wobbly blob. *Scatter* flips random modules. *Logo* wipes a
  square in the middle and draws a logo on top.
* **Counting damage in bytes.** `damagedBytes()` marks a byte as damaged if any of its 8 modules
  differs from the original. This is the number that matters, because Reed-Solomon counts wrong *bytes*.
* **Every change re-runs the decoder** and updates the verdict, the repair-budget squares (one row per
  block, with the limit of repairable bytes per block), the explanation card, and the "Inside the decoder" panel.
* **Verdict logic:** decoded and equal to the original text means *Recovered*; decoded but different
  means *read the wrong message* (rare miscorrection); failed means *can't read*.
* **First impression.** On load the code is already stained by a fixed seeded blob (and the code
  shrinks the stain automatically if it were ever too strong to repair), so a first-time visitor sees the
  point immediately.
* **The "how it's made" tabs** simply display the stages saved by the encoder. **Go deeper** panels
  show the decoder's internals, a GF(256) calculator, the generator polynomial and the capacity table.

---

## 8. `tests/`

* `tests/run-node.js` (`node tests/run-node.js`) and `tests/tests.html` (open in a browser) check:
  GF(256) properties; the standard's "HELLO WORLD" worked example; the format-bit examples; the block
  tables against grid capacity; encode-then-decode round trips for many texts, levels and masks;
  thousands of random Reed-Solomon damage cases (all repaired within the limit; damage beyond the limit
  detected and refused); and whole-code damage at and just above the limit.
* We also scanned generated codes (clean, damaged, and with a logo hole) with an independent decoder
  to confirm real scanners accept them.
