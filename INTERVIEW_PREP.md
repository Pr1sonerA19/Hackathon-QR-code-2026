# Interview prep: likely questions and short answers

Learn these in your own words. If a question is about a file, open it and read the comments first.

**1. In one sentence, what does your project show?**
A QR code contains hidden extra bytes that let a decoder rebuild damaged parts, so it can lose a chunk of itself and still scan, until the damage passes a limit.

**2. Why does a damaged QR code still work?**
The encoder adds Reed-Solomon repair bytes. They are maths computed from the message so the whole block fits a pattern. The decoder checks the pattern, works out which bytes break it and by how much, and corrects them.

**3. How many errors can it fix?**
Up to half the number of repair bytes in each block. Each error has two unknowns, where it is and what the correct value is, and each repair byte supplies one equation. Level M, version 4: 18 repair bytes per block, so 9 damaged bytes per block.

**4. What happens past the limit?**
There is not enough information to separate damage from message, so the decoder detects an inconsistency and refuses. In rare cases a heavily damaged code can look like a different valid code; our verdict calls that out ("read the wrong message"). In our test of 2,000 random cases past the limit, the decoder refused every one.

**5. What is Reed-Solomon?**
An error-correcting code that treats data as a polynomial. Repair bytes are the remainder of dividing by a fixed generator polynomial. It is also used in CDs, DVDs, and deep-space communication.

**6. Why GF(256)? Why not normal arithmetic?**
We need to add, multiply and divide bytes and always get a byte. In GF(256) adding is XOR and multiplying adds logarithms, and every non-zero byte has an inverse. Normal arithmetic overflows past 255.

**7. How does multiplication work in GF(256)?**
`a * b = EXP[LOG[a] + LOG[b]]`. The tables are built by repeatedly doubling a number and, whenever it exceeds 255, XOR-ing with 0x11D (the polynomial the QR standard specifies).

**8. Walk me through generating a code.**
Pick a mode, pick the smallest version, turn text into bits plus padding, group into bytes, split into blocks, add repair bytes per block, interleave the blocks, place bits along the zig-zag path, try all eight masks and keep the lowest penalty, write the format info. The "How this code was made" panel shows each stage for the current message.

**9. What are the three big squares for?**
Finder patterns. Their 1:1:3:1:1 stripe ratio is easy for a scanner to spot at any rotation, and three corners (not four) tell it which way is up.

**10. Why are there masks?**
To avoid big solid areas and stripes that look like a finder pattern, which confuse scanners. The encoder XORs the data with one of 8 fixed patterns, scores each for ugly patterns, and keeps the lowest. The mask number is stored in the format info so the decoder can undo it.

**11. Why interleave the blocks?**
A scratch usually damages neighbouring bytes. Interleaving spreads those bytes across different blocks, so each block has only a few errors and stays within its repair limit.

**12. Why does level H allow a logo in the middle?**
Level H has the most repair bytes (about 30% of capacity). A logo covers a patch of modules, which is a patch of bytes, and level H can rebuild them. Try the "logo" button at level H, then at level L.

**13. How do you know your code is correct?**
We reproduce the standard's worked "HELLO WORLD" example byte-for-byte; we check the block tables against the grid size for every version and level; we fuzz the decoder with thousands of random errors; and we scanned our codes (including damaged ones) with an independent decoder, which agreed with ours.

**14. What did you not do?**
We start from the grid, not a camera photo. Finding the code in a picture and straightening it is a separate problem. We support versions 1 to 10 and the numeric, alphanumeric and byte modes.

**15. Why did you write it without a QR library?**
The rules say the mechanism being explained must run in our own code, and the point is to show how it works. We wrote the encoder, Reed-Solomon, and decoder ourselves. (Be ready to say how you used AI tools; see the fairness page.)

---

### Questions to practise answering with the code open

* "Show me where the repair bytes are computed." (`reedsolomon.js`, `encode`; called from `encoder.js`, stage 5)
* "Show me where the decoder finds the damaged bytes." (`reedsolomon.js`, `decode`: Berlekamp-Massey, Chien search)
* "What does `damagedBytes` do and why count bytes, not modules?" (`ui.js`; Reed-Solomon counts wrong bytes, and 8 modules make a byte)
* "What happens if I type something very long?" (the encoder reports it is too long for versions 1 to 10)
* "What does the orange vs blue view show?" (repair bytes vs message bytes, using the `cwIndex` map from the encoder)
