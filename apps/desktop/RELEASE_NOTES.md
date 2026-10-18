## StepForge as a desktop app

StepForge, the free, open-source, local-first QA studio, now installs like any app: no Node.js, no Git, no terminal.
Web, API, database, email, performance, phone and desktop app testing, in one window, on your own computer.

**New in this release:** the desktop app for macOS, Windows and Linux; manual testing step by step (step → what you see
→ screenshot or clip → pass / fail / blocked / skip); frames inside frames (`#outer >>> #inner`); downloads checked
against SHA-256; and a full QA pass (104 findings, all resolved). Full notes:
[What's new](https://github.com/zarindev/StepForge/blob/main/docs/WHATS_NEW.md).

### Which file?

| Your computer | Download |
| --- | --- |
| Mac with Apple silicon (M1, M2, M3, M4 …) | `StepForge-<version>-mac-arm64.dmg` |
| Mac with an Intel processor | `StepForge-<version>-mac-x64.dmg` |
| Windows 10 or 11 (64-bit) | `StepForge-<version>-win-x64.exe` |
| Linux, any distribution | `StepForge-<version>-linux-x86_64.AppImage` |
| Debian, Ubuntu, Mint … | `StepForge-<version>-linux-amd64.deb` |

### Install

- **macOS:** open the `.dmg`, drag StepForge to Applications. The first time, **right-click StepForge → Open → Open**
  (the app is not signed yet; or System Settings → Privacy & Security → **Open Anyway**).
- **Windows:** run the `.exe`. If SmartScreen appears: **More info → Run anyway** (not signed yet).
- **Linux:** `chmod +x StepForge-*.AppImage && ./StepForge-*.AppImage`, or `sudo apt install ./StepForge-*.deb`. UI
  tests need Chromium's system libraries; see the guide.

The first start downloads Chromium for UI tests (about 180 MB) and Mailpit for email tests, then the dashboard opens.
Choose **Load demo workspace** to see it at work.

Step-by-step guide, data location, updating and uninstalling:
[Desktop app guide](https://github.com/zarindev/StepForge/blob/main/docs/STEPFORGE_DESKTOP.md).
