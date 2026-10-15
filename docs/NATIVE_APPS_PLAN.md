# Plan: native mobile and desktop apps

_By Md Zarin Tasnim · part of the StepForge documentation_

**Status: N1 (Electron desktop apps, [DESKTOP_APPS.md](DESKTOP_APPS.md)), N2 (Android apps,
[ANDROID_APPS.md](ANDROID_APPS.md)), N3 (iOS apps, [IOS_APPS.md](IOS_APPS.md)), N4 (gestures, the phone recorder, phone
diagnosis and device campaigns) and N5 (macOS and Windows apps, [NATIVE_DESKTOP_APPS.md](NATIVE_DESKTOP_APPS.md)) are
done. In N6, image locators are done ([IMAGE_LOCATORS.md](IMAGE_LOCATORS.md)) and Linux desktop apps are
planned, as is N7.**
StepForge tests web applications (including mobile web, see [WEB_APPS.md](WEB_APPS.md)), Electron desktop apps, and
Android and iOS apps. This page is the plan for testing **native** apps — Android, iOS, Windows, macOS and
Linux desktop apps — with the same scenarios, steps, runs, evidence, diagnosis, campaigns and exports, while keeping
StepForge's rules: **free, open source, and running on your own computer** (no device clouds, no paid services).

## What can be tested from which computer

Operating systems restrict which tools run where. These limits come from the platforms, not from StepForge:

| App to test | From Windows | From macOS | From Linux | Engine (all open source) |
|---|:---:|:---:|:---:|---|
| Android apps (emulator or USB phone) | ✅ | ✅ | ✅ | Appium + UiAutomator2 driver (Apache-2.0), Android SDK emulator |
| iOS / iPadOS apps (simulator or iPhone) | — | ✅ | — | Appium + XCUITest driver (Apache-2.0); needs Xcode, which runs only on macOS |
| Windows desktop apps (Win32, WPF, WinForms, UWP) | ✅ | — | — | Appium NovaWindows driver (UI Automation; Apache-2.0) |
| macOS desktop apps | — | ✅ | — | Appium Mac2 driver (Apache-2.0, Apple's XCTest) |
| Linux desktop apps (GTK, Qt) | — | — | ✅ | AT-SPI accessibility (pyatspi, LGPL) through a small helper |
| Electron desktop apps (Slack-, VS Code-style) | ✅ | ✅ | ✅ | Playwright's Electron support — the engine StepForge already uses |
| Flutter / React Native apps | as Android / iOS above | | | Appium drivers; React Native `testID` and Flutter keys become locators |
| Apps without accessibility (games, remote desktops) | ✅ | ✅ | ✅ | Image matching with OpenCV (Apache-2.0), last resort |

Notes: an iPhone (real device) needs the app signed with an Apple ID — a free Apple ID works for development
signing; the simulator needs nothing extra. Android emulators need hardware virtualization enabled. Native desktop
tests take over the mouse and keyboard of that computer while they run (Electron tests do not).

## How it fits into StepForge

**One test model.** A native test is still a list of steps: `ui.click`, `ui.fill`, `ui.assert`, `ui.extract`,
`ui.waitFor`, `ui.screenshot`, `ui.visualCheckpoint` keep their meaning, so blocks, elements, data, hooks, conditions,
campaigns and diagnosis work unchanged. A few steps are added where native apps need them.

**Application platform.** An application gets a *platform*: web (today), android, ios, windows, macos, linux or
electron. Its environments describe what to start instead of a base URL: the app file (`.apk`, `.app`/`.ipa`, `.exe`,
an Electron app path) or an installed app's id, the device (an emulator name, a simulator, a USB phone, "this
computer"), and options such as "reset app data before each test".

**A native executor** (`@stepforge/executor-native`) implements the `ui.*` steps for native platforms. It talks the
standard WebDriver protocol to a local Appium server with a small built-in client (no client library to install). StepForge installs Appium and the
drivers it needs into its own `data/` folder (no global installs) and starts and stops Appium itself, like it does
with Mailpit. Electron apps go through Playwright instead, so they get traces and the existing recorder too.

**Locators.** The ranked-locator idea stays: accessibility id (from `testID` / `accessibilityIdentifier` /
`AutomationId`) first, then visible text, then platform locators (Android UiAutomator, iOS predicate / class chain,
Windows UI Automation conditions), XPath last. Saved elements and self-healing work as on the web.

**New steps for native apps:** `ui.swipe` (direction, or from an element to another), `ui.longPress`,
`ui.scrollTo` (scroll until an element shows), `ui.back` (Android back), `ui.hideKeyboard`, `ui.rotate`,
`ui.appState` (launch, close, put in background, reset), `ui.deepLink` (open `myapp://…`), `ui.setLocation` and
`ui.permission` (grant or deny), `ui.pushNotification` (simulators/emulators), and `ui.menu` (desktop menu bars).

**Evidence and diagnosis.** Screenshot per step, a screen recording (Appium's recorder; ffmpeg for desktops), the
device log (Android logcat, iOS system log) instead of the browser console, and the screen's element tree (XML) at
failure time. New diagnosis rules: the app crashed or froze (crash in the device log), a permission dialog or the
keyboard covers the element, the element exists but is off screen, the app was not installed.

**Recorder for native apps.** A mirror of the device screen in the dashboard: clicking on it finds the element under
the pointer in the element tree, proposes ranked locators and records the step — the same review-and-save flow as the
web recorder.

**Code export.** New targets: Appium + WebdriverIO (JavaScript/TypeScript), Appium Python client (pytest), Appium Java
client (JUnit 5), and Maestro YAML flows for mobile; Electron through the existing Playwright targets.

**Campaigns.** "Browsers × screen sizes" becomes "devices": one click runs a test set on a Pixel emulator, an iPhone
simulator and a USB phone, with the combined report.

## Phases

Each phase ends with the same bar as the web phases: unit tests, end-to-end tests against a demo app, docs, and a
fresh-clone check on the operating systems it supports.

| Phase | Delivers | Runs on | Size |
|---|---|---|---|
| N1 — Electron apps ✅ done | Platform "electron"; Playwright Electron launch; all `ui.*` steps, recorder, traces; a small Electron demo app | Windows, macOS, Linux | S |
| N2 — Native foundation + Android ✅ done | Platform model, environments for apps/devices; native executor; Appium + UiAutomator2 managed locally; core `ui.*` steps; evidence (screens, recording, logcat, element tree); `stepforge doctor native` checks Java, Android SDK, ADB, emulators; demo Android app (CareClinic mobile) | Windows, macOS, Linux | L |
| N3 — iOS ✅ done | XCUITest driver, simulator management (`xcrun simctl`), signing guidance for real iPhones, iOS demo build | macOS | M |
| N4 — Mobile gestures and recorder ✅ done | The native steps above; native recorder with screen mirror and element tree; native diagnosis rules; device campaigns | as N2/N3 | L |
| N5 — Windows and macOS desktop ✅ done | NovaWindows (or FlaUI) and Mac2 drivers; desktop steps (menus, windows, keyboard shortcuts); demo desktop app | Windows / macOS | M |
| N6 — Linux desktop and image fallback (images ✅ done, with a built-in matcher instead of OpenCV) | AT-SPI helper for GTK/Qt; OpenCV image matching as a last-resort locator for any platform | Linux (images: all) | M |
| N7 — Export and CI | Appium (JS, Python, Java) and Maestro export targets; CI templates: Android emulator on Linux runners, iOS simulator on macOS runners, Windows runners | all | M |

Recommended order: **N1 first** (small, reuses everything, covers many "desktop apps" people use), then **N2**
(Android runs on every computer), then N3–N7 by demand.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Native toolchains are heavy (Android SDK ≈ several GB, Xcode) | Optional: web users install nothing new. `stepforge doctor native` explains what is missing per platform with exact commands. |
| Emulators and simulators are slower and flakier than browsers | Auto-waiting on every action (as on the web), retries per step, app reset between tests, generous default timeouts per platform. |
| Apps without accessibility ids | Encourage ids in the docs (one line per framework); text and platform locators next; image matching last. |
| Desktop tests take over the screen | Documented; run them in a separate user session or a virtual machine; Electron tests are unaffected. |
| Licences | Only permissive or LGPL components, each run as a separate process; no closed-source driver is required (WinAppDriver is avoided). |
| Real iPhones need signing | Simulators first; real-device signing documented with a free Apple ID. |

## Not planned

Paid device clouds (BrowserStack, Sauce Labs and similar) — against the "free and local" rule; adding a remote Appium
URL later would make them usable for people who already pay for one. Consoles, smart TVs and car systems.
