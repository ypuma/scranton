# Voice dictation

Dictate text locally in the Windows x64 desktop app.

[Back to the README](../../README.md)

## Record and transcribe

Free-text fields in the desktop app have a microphone button. Click it, speak, then click again to stop. Press **Esc** to cancel. Recording stops automatically after at most **five minutes**. Scranton inserts the recognized text into the field; it never sends it automatically. Review the text before sending it.

On first use, Scranton offers a one-time download for the selected speech model. You can see progress or cancel. The fast model (default) is about **190 MB**. The more accurate model is about **574 MB** and notably slower: it took around **11 seconds** for ten seconds of speech on the test machine. Once the selected model is installed, dictation works offline. The recording stays on the computer and is not retained permanently.

Under **Settings → Voice**, select **Auto** (automatic language detection, default), **Deutsch**, or **English**. You can download or delete models and test the microphone there. Dictation is currently available on Windows x64, with macOS and Linux support planned for later.

If Windows blocks the microphone, go to **Windows Settings → Privacy → Microphone** and turn on **Allow desktop apps to access your microphone**. See the [desktop implementation and measurements](../DESKTOP.md#lokales-diktieren) and the [voice API](../CONTROL.md#voice-dictation-api).
