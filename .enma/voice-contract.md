# Voice dictation - contract

Binding for the Node server, the desktop shell, the visualizer, the desktop packaging and the docs. Set by Core on 2026-11-23.

The user asked, verbatim: "add voice, dictation". Asked how speech should become text, they chose: "Lokal auf deinem PC mit Whisper: offline und privat, das Sprachmodell (ca. 500 MB) wird einmalig geladen" (locally on the PC with Whisper: offline and private, the speech model of about 500 MB is downloaded once).

Known fact: `webkitSpeechRecognition` does not work in WebView2/Edge (MicrosoftEdge/WebView2Feedback#1613). Recognition must therefore be our own.

## 1. What the user gets
- **A microphone button** on every free-text input:
  - the new-request composer
  - the follow-up / conversation message
  - "Message a running agent"
  - the human-input feedback field
  - plan feedback
  - any other multi-line prompt input
- **Recording:**
  - Click to start and click again to stop. `Escape` cancels.
  - While recording, show a level meter and a timer. Recording stops automatically after 5 minutes.
- **After stopping:**
  - "Transcribing…", then the text is inserted at the cursor, or appended with a space.
  - Nothing is sent automatically. The user reviews it and presses Send.
- **First use:**
  - If no model is installed, the button offers "Download speech model (N MB)", with progress and cancel.
  - After that, everything works offline.
- **Language:** Auto (default), Deutsch or English, set in Settings → Voice. The same section also offers:
  - model choice
  - download / delete model
  - a microphone test
- **Platforms:** when no engine exists for the platform (today macOS / Linux), the buttons are hidden and Settings explains why.

## 2. Engine (local only)
- **Binary:** whisper.cpp, the official prebuilt Windows x64 CPU release (`whisper-bin-x64.zip` from `ggml-org/whisper.cpp`).
  - Pinned by version and SHA-256 like rg/fd in `tools-lock.json` / `scripts/desktop-tools.mjs`.
  - Staged into the packaged app.
  - Its MIT license is staged with the other licenses (`app/licenses/`).
  - No compilation and no new npm or Rust dependency.
- **Models:** ggml models from Hugging Face `ggerganov/whisper.cpp`.
  - Offer two: a fast one (e.g. `small`, q5) and a precise one of about 500 MB (e.g. `large-v3-turbo-q5_0`).
  - The default is chosen from a MEASURED latency on this machine; record the numbers. Pick the one that transcribes 10 s of German in at most about 5 s if possible.
  - Each model is pinned by size and SHA-256 in a committed lock file. A download is verified before use and stored atomically.
  - Store models in a LOCAL, non-roaming cache, `%LOCALAPPDATA%\dev.scranton.desktop\models\` (on other OS the platform's local data dir), never in roaming app data.
- **Process:** whisper runs as an app helper outside the agent sandbox, with arguments only from Scranton, never from a model.
  - Use `whisper-server` (the model stays loaded; idle shutdown after 10 min) or `whisper-cli` per request, whichever measures better.
  - Bind to 127.0.0.1 only.
  - Kill it with the Node server's process tree on quit.
- **Privacy:**
  - Audio never leaves the machine and is never logged or kept.
  - The temp WAV goes in a private temp dir and is deleted in a `finally`.
  - The transcript is returned only to the caller.

## 3. Server API (Node, same loopback / `X-Scranton-Client: 1` rules as the other routes)
- `GET /api/voice/status` → `{ available, reason?, engine: { installed, version }, models: [{ id, label, bytes, installed, download?: { received, total } }], model, language }`
  - `model` is the selected id. `language` is `auto|de|en`. `reason` is set when unavailable (e.g. `unsupported_platform`, `engine_missing`).
- `POST /api/voice/settings` `{ model?, language? }` → the status. Persisted in `<data>/voice.json`.
- `POST /api/voice/models/:id/download` → `202`. Progress is visible through status. `DELETE` on the same path cancels a download or removes the model → `204`.
- `POST /api/voice/transcribe?language=auto|de|en`
  - Body: `audio/wav`, 16 kHz mono PCM16, at most 10 MB.
  - Returns `{ text, language, durationMs, model }`.
  - Errors:
    | Status | Meaning |
    |---|---|
    | 409 `model_missing` | no model installed |
    | 413 | body too large |
    | 415 | not a 16 kHz mono PCM16 WAV |
    | 503 `engine_unavailable` | no engine for this platform or engine not usable |
    | 429 `busy` | one transcription at a time |

## 4. Desktop shell
- Grant microphone access ONLY to the main window's own server origin (`http://127.0.0.1:<port>`) and deny every other permission request, using the WebView2 permission event. Find what Tauri 2 / wry does by default and change it only as needed.
- macOS: add `NSMicrophoneUsageDescription` for future builds.

## 5. UI audio
- Capture with `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`.
- Resample to 16 kHz mono PCM16 in an AudioWorklet (or OfflineAudioContext) and build the WAV in JS. No new dependencies.
- Release the microphone when recording stops.
- Show errors plainly: permission denied, no microphone, model missing, too long, busy.

## 6. Docs
- `README.md` (German): "Diktieren": how to use it, the model download, offline and privacy, the languages, the platform limits.
- `docs/DESKTOP.md`: the voice architecture, the pinning, the cache location.
- `docs/CONTROL.md`: the voice routes.
