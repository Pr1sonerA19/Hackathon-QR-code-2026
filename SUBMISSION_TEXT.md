# Draft text for the submission form

(Edit these into your own words before you submit.)

## Project title
Why a scratched QR code still scans

## One-line description
Damage a real QR code with your mouse and watch Reed-Solomon error correction rebuild the message, until you damage it too much.

## Project page text (short)

**The technology:** QR codes, which people scan every day.

**The mechanism inside:** Reed-Solomon error correction. Before a QR code is drawn, extra "repair bytes" are calculated from your message with polynomial maths. A scanner uses those bytes to find and fix damaged parts of the code.

**What you can do:** Type a message and a real QR code appears. Drag across the code to scratch it, add a coffee stain, scatter noise, or cover the middle with a logo. After every change our own decoder reads the damaged code and tells you whether it recovered the message, how many damaged bytes it fixed, and how many it could still afford to lose. Push past the limit and it refuses to guess.

**What you learn:** The code is hiding extra data that exists only to repair itself, and the repair level (L, M, Q, H) trades message space against survivable damage. Switch to the orange/blue view to see where the repair bytes sit in the grid.

**How deep it goes:** Five generation steps (text to bits, bytes, repair bytes, placement, mask), plus the decoder's internals (syndromes, error-locator polynomial, repairs), a GF(256) calculator, the generator polynomial, and a capacity table.

**What is computed by our code:** everything, with no QR libraries: GF(256) arithmetic, Reed-Solomon encode and decode (Berlekamp-Massey, Chien search, Forney), QR layout, masking and penalty scoring, the encoder and the decoder.

**How we checked it:** it reproduces the standard's worked "HELLO WORLD" example; its decoder repairs thousands of random errors within the limit and refuses beyond it; and an independent scanner (OpenCV) agrees with it on clean, damaged and logo-covered codes.

**Honest limits:** it decodes from the grid of squares rather than from a camera photo; versions 1 to 10; numeric, alphanumeric and byte modes.

## Demo video script (about 75 seconds)

*Screen recording of the live link. Speak slowly. Record at 1080p.*

1. **(0:00-0:08)** Open the page. "This is a QR code that someone has already smudged with a coffee stain. It still scans. Why?"
2. **(0:08-0:20)** Point at the green verdict and the repair budget. "Our decoder found eight damaged bytes and fixed all of them. Each square here is one damaged byte it can afford to lose."
3. **(0:20-0:35)** Drag across the code with the mouse. "Let's damage it more." Watch the squares fill. "Every damaged byte uses up some of the budget."
4. **(0:35-0:45)** Keep dragging until it turns red. "Past the limit it can't tell the damage from the message, so it refuses to guess."
5. **(0:45-0:58)** Click Undo, tick "Show the hidden repair data". "The orange part is the repair data: maths computed from the message, hidden inside the code."
6. **(0:58-1:08)** Choose level H, click "Put a logo in the middle". "More repair data lets it survive even a logo covering the middle."
7. **(1:08-1:15)** Scroll to "How this code was made". "All of this is our own code: no QR libraries. You can see every step, from text to bits to repair bytes to the finished grid."

## Things to double check before submitting
* The live link opens in a private browser window with no sign-in.
* The repository is public and includes `index.html` at the top level.
* The video link works without a login.
* You can explain every file (use `CODE_WALKTHROUGH.md` and `INTERVIEW_PREP.md`).
