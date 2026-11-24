/* =====================================================================
   reedsolomon.js  -  Reed-Solomon error correction (encode AND decode)
   =====================================================================

   THE BIG IDEA
   ------------
   Treat your message bytes as the coefficients of a polynomial:
        m(x) = m0*x^(k-1) + m1*x^(k-2) + ... + m(k-1)
   Reed-Solomon adds `ecLen` extra "check" bytes so that the final codeword
   polynomial is exactly divisible by a special generator polynomial
        g(x) = (x - a^0)(x - a^1) ... (x - a^(ecLen-1))      (a = alpha)
   That means the codeword evaluates to ZERO at the points a^0 ... a^(ecLen-1).

   ENCODING = polynomial long division: the check bytes are the REMAINDER of
   m(x) * x^ecLen divided by g(x). Appending them makes the whole thing divisible.

   DECODING: evaluate the received bytes at those same points. The results are
   called SYNDROMES. If a byte was damaged, some syndromes are non-zero, and
   the pattern of syndromes tells us WHERE the damage is and WHAT it was:
       1. Berlekamp-Massey   -> finds the "error locator polynomial"
       2. Chien search       -> tries every position to find its roots (= where)
       3. Forney algorithm   -> works out the size of each error (= what)
   With ecLen check bytes we can repair up to floor(ecLen / 2) wrong bytes
   (each error costs 2 check bytes: one to find where, one to find what).

   Polynomials here are plain arrays. In "high-first" arrays index 0 is the
   highest power (like how we write them). In "low-first" arrays index 0 is the
   constant term (easier for the decoder maths). Each function says which.
   ===================================================================== */
(function () {
  "use strict";
  const QR = (window.QR = window.QR || {});
  const GF = QR.GF;

  /** Multiply two polynomials (high-first arrays) over GF(256). */
  function polyMul(p, q) {
    const out = new Array(p.length + q.length - 1).fill(0);
    for (let i = 0; i < p.length; i++)
      for (let j = 0; j < q.length; j++)
        out[i + j] ^= GF.mul(p[i], q[j]);
    return out;
  }

  /** Generator polynomial of the given degree (high-first, leading coeff 1). */
  function generator(degree) {
    let g = [1];
    for (let i = 0; i < degree; i++) g = polyMul(g, [1, GF.alphaPow(i)]); // times (x - a^i)
    return g;
  }

  /**
   * ENCODE: returns the `ecLen` check bytes for `data` (array of bytes).
   * This is polynomial long division done byte by byte (an "LFSR").
   */
  function encode(data, ecLen) {
    const gen = generator(ecLen);
    const rem = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ rem.shift(); // the byte that "falls out" of the front
      rem.push(0);
      for (let i = 0; i < ecLen; i++) rem[i] ^= GF.mul(gen[i + 1], factor);
    }
    return rem;
  }

  /** Evaluate a LOW-first polynomial at x. */
  function evalLow(poly, x) {
    let y = 0;
    for (let i = poly.length - 1; i >= 0; i--) y = GF.mul(y, x) ^ poly[i]; // Horner's rule
    return y;
  }

  /**
   * SYNDROMES: S[j] = received(a^j) for j = 0..ecLen-1.
   * `received` is the whole block (data bytes then check bytes), high-first.
   * All zero  <=>  no detectable errors.
   */
  function syndromes(received, ecLen) {
    const S = [];
    for (let j = 0; j < ecLen; j++) {
      const point = GF.alphaPow(j);
      let s = 0;
      for (const byte of received) s = GF.mul(s, point) ^ byte; // Horner's rule
      S.push(s);
    }
    return S;
  }

  /**
   * Berlekamp-Massey: from the syndromes, build the error locator polynomial
   * Lambda(x) (low-first). Its degree L is the number of errors it believes
   * there are. Its roots are the inverses of the error positions.
   */
  function berlekampMassey(S) {
    let C = [1];   // current locator guess
    let B = [1];   // copy of C from before the last length change
    let L = 0;     // current number of errors assumed
    let m = 1;     // steps since B was updated
    let b = 1;     // discrepancy when B was saved
    for (let n = 0; n < S.length; n++) {
      // discrepancy d: how wrong is the current guess at step n?
      let d = S[n];
      for (let i = 1; i <= L; i++) d ^= GF.mul(C[i] || 0, S[n - i]);
      if (d === 0) { m++; continue; }                // guess still fits
      const saved = C.slice();
      const coef = GF.div(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] ^= GF.mul(coef, B[i]); // C = C - coef*x^m*B
      if (2 * L <= n) { L = n + 1 - L; B = saved; b = d; m = 1; }       // need more errors
      else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop(); // trim zero top terms
    return { locator: C, L };
  }

  /**
   * DECODE one block. Returns:
   *   ok          true if the block is now consistent (maybe after repairs)
   *   corrected   the repaired block (array of bytes)
   *   errors      [{index, was, now}] - every byte that was changed
   *   syndromes   the syndromes computed from the received bytes
   *   locator     the error locator polynomial (low-first)
   *   reason      why it failed (when ok is false)
   */
  function decode(received, ecLen) {
    const n = received.length;
    const S = syndromes(received, ecLen);
    const result = {
      ok: true, corrected: received.slice(), errors: [], syndromes: S,
      locator: [1], reason: "",
    };
    if (S.every((s) => s === 0)) return result; // nothing wrong

    // 1. How many errors, and the locator polynomial
    const { locator, L } = berlekampMassey(S);
    result.locator = locator;
    if (L > Math.floor(ecLen / 2) || locator.length - 1 !== L) {
      result.ok = false;
      result.reason = "more damaged bytes than the repair data can fix";
      return result;
    }

    // 2. Chien search: position i (0 = first byte) has locator root a^-(n-1-i)
    const positions = [];
    for (let i = 0; i < n; i++) {
      if (evalLow(locator, GF.alphaPow(-(n - 1 - i))) === 0) positions.push(i);
    }
    if (positions.length !== L) {
      result.ok = false;
      result.reason = "the damage pattern does not match any repairable error";
      return result;
    }

    // 3. Forney: error magnitudes.  omega(x) = S(x) * Lambda(x)  mod x^ecLen
    const omega = new Array(ecLen).fill(0);
    for (let i = 0; i < ecLen; i++)
      for (let j = 0; j < locator.length && i + j < ecLen; j++)
        omega[i + j] ^= GF.mul(S[i], locator[j]);
    // formal derivative of Lambda (in GF(2^k) only odd-power terms survive)
    // d/dx of c_j x^j is j*c_j x^(j-1), and j*c_j is c_j for odd j, 0 for even j.
    const dLoc = [];
    for (let k = 0; k < locator.length - 1; k++) dLoc.push((k + 1) % 2 === 1 ? locator[k + 1] : 0);

    const fixed = received.slice();
    for (const i of positions) {
      const X = GF.alphaPow(n - 1 - i);      // the locator of this position
      const Xinv = GF.inv(X);
      const denom = evalLow(dLoc, Xinv);
      if (denom === 0) {
        result.ok = false;
        result.reason = "could not work out the size of an error";
        return result;
      }
      const magnitude = GF.mul(X, GF.div(evalLow(omega, Xinv), denom));
      fixed[i] ^= magnitude;
      result.errors.push({ index: i, was: received[i], now: fixed[i] });
    }

    // Safety check: after repairing, every syndrome must be zero.
    if (syndromes(fixed, ecLen).some((s) => s !== 0)) {
      result.ok = false;
      result.errors = [];
      result.reason = "repair did not produce a valid codeword";
      return result;
    }
    result.corrected = fixed;
    return result;
  }

  QR.RS = { generator, encode, syndromes, decode, evalLow };
})();
