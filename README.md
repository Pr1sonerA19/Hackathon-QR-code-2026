# Why a scratched QR code still scans

An interactive explainer for the CIS hackathon. It shows **one idea**: a QR code stores extra
*repair bytes* (Reed-Solomon error correction) next to your message, so it can lose a chunk of
itself and still be read.

You type a message, the page builds a real QR code, and you damage it with your mouse
(or with the coffee-stain / noise / logo buttons). A decoder written for this project reads the
damaged code, repairs it, and tells you whether it recovered the message. Push the damage past
the limit and it refuses to guess.

## Run it

* **Just double-click `index.html`.** No install, no server, no internet, no sign-in.
* To run the self-checks, open `tests/tests.html` in a browser (or run `node tests/run-node.js`).

## What is in this folder

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page and how it looks |
| `js/gf256.js` | Arithmetic on bytes (the "Galois field" Reed-Solomon needs) |
| `js/reedsolomon.js` | Reed-Solomon: add repair bytes, find and fix damaged bytes |
| `js/tables.js` | The fixed numbers from the QR standard (sizes, block layouts) |
| `js/layout.js` | Where the finder squares, timing lines, format info and data go in the grid |
| `js/encoder.js` | Text to QR code (the "how it is generated" half) |
| `js/decoder.js` | Damaged QR grid to text (the "how it is read and repaired" half) |
| `js/ui.js` | Drawing, damage tools, explanations. Contains no QR maths |
| `tests/` | Self-checks (known test vectors, random fuzzing, round trips) |
| `CODE_WALKTHROUGH.md` | Step-by-step explanation of every file and why it is needed |
| `INTERVIEW_PREP.md` | Likely judge questions with plain-language answers |
| `SUBMISSION_TEXT.md` | Draft project-page text and a demo-video script |

## How it meets the rules

* **Computed, not canned.** Every output (the code, the repair bytes, the verdict) is calculated
  from the inputs by the code in `js/`. There are no QR or Reed-Solomon libraries and no AI services.
* **Runs in a browser at a public link** with no sign-in, download or API key (plain HTML, CSS and JavaScript).
* **Understandable alone in two minutes.** The page opens with an already-smudged code that still
  reads, three short instructions, and a live verdict. Depth (decoder internals, GF(256)
  calculator, generator polynomial, capacity table) sits in "Go deeper" panels.

## How we checked it is correct

* The encoder reproduces the **worked example from the QR standard tutorials** ("HELLO WORLD",
  versions 1-Q and 1-M): the same data bytes and the same repair bytes.
* The block tables are cross-checked against the grid geometry for all 10 versions and 4 levels.
* The Reed-Solomon decoder is fuzz-tested with thousands of random errors: everything within
  the limit is repaired, and damage beyond the limit is detected and refused.
* Codes generated here were scanned by an **independent decoder** (OpenCV), including damaged
  ones, and it agreed with our decoder on what is readable and what is not.

## Limitations (honest list)

* The decoder starts from the grid of dark/light squares. A real phone first has to find the
  code in a photo, straighten it and read the pixels; we do not do that part.
* Versions 1-10 only (21x21 to 57x57), and the numeric, alphanumeric and byte modes.
* Real scanners can use extra tricks, so a phone may read some codes this decoder gives up on.

## Put it online (GitHub Pages, Windows)

1. Make a free GitHub account, click **New repository**, name it (for example `qr-repair`), set it to **Public**.
2. On the new repository page choose **uploading an existing file**, drag in **everything from
   this folder** (including the `js` and `tests` folders), and click **Commit changes**.
3. Go to **Settings, then Pages**. Under *Build and deployment* choose **Deploy from a branch**,
   branch **main**, folder **/ (root)**, and Save.
4. After a minute your live link appears at the top of that page:
   `https://YOUR-NAME.github.io/qr-repair/`. Open it in a private window to check it works
   without signing in. The repository link is your "public repository".

## AI use

Declare how AI tools were used when you submit, following the rules on the hackathon's
fairness page. Whoever presents the project should read `CODE_WALKTHROUGH.md` and
`INTERVIEW_PREP.md` and be able to explain every file in their own words.
