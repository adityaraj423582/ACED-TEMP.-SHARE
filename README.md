# Aced

A Windows overlay for live interviews. It listens to the meeting's audio, notices when the
interviewer has finished a question, and shows a short suggested answer in 3–4 points. The
overlay is **hidden from screen sharing** in Meet, Zoom and Teams. Your microphone is never
used.

---

## 1. Install (one time, about 5 minutes)

Install these two first:

- **Node.js 24** — https://nodejs.org/dist/latest-v24.x/ (download the `-x64.msi` file).
  Node 25 or newer will not work.
- **Git** — https://git-scm.com/download/win

Then open **PowerShell** and run these one at a time:

```powershell
npm install -g pnpm@11.5.1
```

```powershell
git clone https://github.com/adityaraj423582/ACED-TEMP.-SHARE.git aced
```

```powershell
cd aced
```

```powershell
pnpm install
```

```powershell
pnpm build
```

Both of the last two must finish without errors. `pnpm install` downloads about 120 MB.

## 2. Get your keys

| Key                   | Needed for                  | Where                                                         |
| --------------------- | --------------------------- | ------------------------------------------------------------- |
| **Groq**              | writing the answers         | https://console.groq.com/keys → _Create API Key_              |
| **Deepgram**          | live transcription          | https://console.deepgram.com → _API Keys_ → _Create_ (Member) |
| Sarvam _(optional)_   | only if Gujarati is spoken  | https://dashboard.sarvam.ai                                   |

## 3. Start

Double-click **`Start Aced.vbs`** in the `aced` folder.

The first time, a **Keys** panel opens. Paste each key with <kbd>Ctrl</kbd>+<kbd>V</kbd> and
press **Save**. Each key is checked on the spot (✓ green = working) and stored encrypted on
this PC. To change keys later, click **Keys** at the top of the overlay.

## 4. Use it in the interview

1. Join the meeting, then press **Start** in the overlay.
2. When the interviewer finishes a question, the answer appears by itself.
3. You can also type a question in the box at the bottom and press <kbd>Enter</kbd>.

For **Gujarati**, pick `sarvam (Gujarati)` in the STT dropdown _before_ pressing Start.

A full transcript with every answer is saved to `Documents\Aced\meeting N.txt`.

| Keys                                          | Action                                     |
| --------------------------------------------- | ------------------------------------------ |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd>              | Answer now (don't wait)                    |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | Solve the coding question on screen        |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> | Hide / show the overlay                    |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | Dim the overlay (compact and faint)        |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Freeze the current answer                  |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> | Quit                                       |
| <kbd>Ctrl</kbd>+<kbd>D</kbd>                  | Close instantly                            |

## 5. Do a test run first

Before the real interview: play any interview video on YouTube, press **Start**, and check
that the transcript appears and answers come up. Then press **Clear** and you are ready.

---

### If something goes wrong

- **"No audio heard"** — press <kbd>Win</kbd>+<kbd>R</kbd>, run `mmsys.cpl`, and in
  **Playback** set your speakers or headphones as both _Default Device_ and _Default
  Communication Device_.
- **A key shows red** — copy it again from the provider's site and Save.
- **`pnpm install` or `pnpm build` fails** — check `node -v` shows `v24`, then run
  `pnpm install` again.
- **Answers slow or "rate limited"** — free Groq keys have a per-minute limit; the app
  switches to a second Groq model automatically. Adding a payment method on Groq removes it.
