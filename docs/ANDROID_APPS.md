# Android apps

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge tests **native Android apps** on an emulator or a USB phone, from Windows, macOS or Linux. It uses the same
tests, runs, reports and diagnosis as web apps. The steps go to the app through **Appium** and its **UiAutomator2**
driver, both open source (Apache-2.0). StepForge installs them into its own `data/tools` folder and starts and stops
them itself. Nothing is installed globally, and no device cloud or account is needed.

This is step N2 of the [native apps plan](NATIVE_APPS_PLAN.md). [iOS apps](IOS_APPS.md) work the same way (N3), and
both have gestures, device steps, a recorder and phone-app diagnosis (N4).

## What you need

| | Why | How to get it |
| --- | --- | --- |
| **Java 17 or newer** | The Android tools run on Java | Android Studio includes one, or install a JDK (for example Eclipse Temurin) |
| **Android SDK** | adb, the emulator, system images | Android Studio, or the command-line tools from developer.android.com/studio |
| **An emulator or a phone** | Where the app runs | Android Studio → Device Manager, or a phone with USB debugging on |
| **Appium + UiAutomator2** | Drives the app | `npm run appium:install`, or **Install Appium** in StepForge |

Check this computer at any time:

```bash
./stepforge.sh doctor native --platform android      # stepforge.bat on Windows
```

```text
Android — ready
  ✓ Java 17 or newer: /Applications/Android Studio.app/Contents/jbr/Contents/Home
  ✓ Android SDK: /Users/me/Library/Android/sdk
  ✓ adb (platform-tools): …/platform-tools/adb
  ✓ Android emulator: …/emulator/emulator
  ✓ Emulators or phones: emulators: Pixel_8 · connected: emulator-5554 (device)
  ✓ Appium and the Android driver: Appium 3.8.0, UiAutomator2 8.7.0 in data/tools/appium

Ready.
```

Every line marked ✗ says how to fix it. The same checks appear on an Android app's **Environments** tab, with an
**Install Appium** button. StepForge finds the SDK through `ANDROID_HOME` / `ANDROID_SDK_ROOT` or where Android
Studio puts it. It finds Java through `JAVA_HOME`, Android Studio's own Java, or (on macOS) the installed JDKs.

Appium needs Node.js 20.19+, 22.12+ or 24+. On any other Node.js version, `appium:install` also downloads Node.js
22 LTS from nodejs.org (checked against its published SHA-256) into `data/tools/node`. That copy only runs Appium.

**Without Android Studio** (command-line tools only), the packages are:

```bash
sdkmanager "platform-tools" "emulator" "platforms;android-35" "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n Pixel -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6
```

Use `x86_64` instead of `arm64-v8a` on Intel and AMD computers.

## Set up an Android app

1. **Applications → New application**, then set **Platform** to _Android app_.
2. **Add environment**. An Android app's environment says which app and which device:

| Field | What to put |
| --- | --- |
| **App file (.apk)** | The build to test, for example `/builds/app-debug.apk`. It is installed on the device for each test |
| **or installed app's package** | An app already on the device: `com.example.app`, and optionally its **start screen** (activity, for example `.MainActivity`) |
| **Emulator** | An emulator on this computer. It starts when a test needs it and keeps running for the next tests |
| **Phone or device serial** | A phone's serial from `adb devices`. Leave both empty to use the only device connected |
| **Reset the app's data before each test** | On by default: every test starts signed out, with empty storage, and the app file is installed again (so a new build with the same version number is really tested) |
| **Show the emulator window** | Off by default: the emulator runs without a window |
| **Extra Appium capabilities** | Optional JSON for anything else Appium supports, for example `{ "appium:language": "fr", "appium:locale": "FR" }` |

Variables and secrets work in every field, for example `{{env.apkPath}}`. That way each environment can test a
different build (debug, staging, release candidate). The **Base URL** is only a name for reports, for example
`app://careclinic`.

The first test on a fresh emulator takes longer: the emulator boots, and Appium installs its helper app once. Later
tests start in a few seconds.

## Writing tests

Tests use the same `ui.*` steps as web apps. Locators are translated to Android, best first:

| Locator | On Android |
| --- | --- |
| **Test id** `sign_in` | The view's resource id (`com.example.app:id/sign_in`), then its content description |
| **Label** | The content description (accessibility label), then the hint |
| **Placeholder** `Email` | The text field's hint |
| **Text** `Sign in` | Exact text, then text that contains it, then a content description |
| **Role** `button "Sign in"` | Buttons, text fields (`textbox`), check boxes, switches, radio buttons, spinners (`combobox`), images, lists… with that text |
| **XPath** | Used as is, against the screen's element tree (see the _element tree_ evidence below) |
| **Image** | A picture of the element, found on the screen — for anything without ids or text ([image locators](IMAGE_LOCATORS.md)) |
| CSS | Not available: CSS is for web pages |

React Native's `testID` and Flutter's semantics labels arrive as resource ids or content descriptions, so **Test id**
finds them too. Ranked locators and self-healing work as on the web. If the first locator stops matching and a later
one still does, the step passes and the run reports the healed locator.

| Step | In an Android app |
| --- | --- |
| Click / Tap / Double-click | Taps the element |
| Fill / Type / Clear | Types into a text field (Fill clears it first) |
| Press a key | `Enter`, `Tab`, `Back`, `Home`, `Escape`, `Backspace`, `Delete`, `Space`, `Menu`, `Search`, arrow keys. With an element, it taps the element first |
| Check / Uncheck | Taps a check box or switch only when it is not already in that state |
| Select | Opens a spinner (drop-down) and taps the option with that text |
| Scroll | To an element (swipes down until it shows, at most ten times), or down / up without an element |
| Wait for | An element to show or to go away |
| Assert | visible, hidden, text, contains, matches, value, attribute, enabled, disabled, checked, unchecked, count |
| Extract | An element's text, an attribute (for example `resource-id`, `content-desc`, `checked`) or the number of matches |
| Screenshot | The screen, or one element |
| Open (navigate) | A deep link such as `careclinic://patients/42`. An app has no pages to open by path |
| Handle dialog | Answers the dialog on screen (an app alert or a system permission request): accept or dismiss, or a named button, waiting for it to appear |
| Conditions | `util.if` / `util.loop` page conditions ("if the rating dialog is visible → close it") |

### Gestures and device steps

These steps are for phone apps (Android and iOS). **Go back** also works in a browser: it presses the browser's Back
button.

| Step | What it does |
| --- | --- |
| Swipe | `up`, `down`, `left` or `right`, on an element or on the screen; with a **target** element, drags the element onto it |
| Long press | Holds the element (default 1 s) |
| Scroll to | Swipes until the element shows (default: down, at most 10 swipes); fails when the screen stops moving |
| Go back | Android's Back key; on iOS the navigation bar's back button |
| Hide keyboard | Closes the on-screen keyboard (nothing happens when it is already closed) |
| Rotate | `landscape` or `portrait` |
| App | `launch`, `close`, `background` (for some seconds, then back) or `reset` (clear the app's data) |
| Open link | A deep link (`careclinic://patients`) |
| Set location | A latitude and longitude for the device's GPS (emulators and simulators) |
| Permission | Grants or revokes `camera`, `location`, `microphone`, `contacts`, `photos`, `notifications`, `calendar`, or a platform permission name (`android.permission.…`) |
| Notification | Sends a push notification to the app (iOS simulators; on Android it needs the app's own push service) |

Steps that only make sense in a browser are reported as not available, and the test stops with a clear message.
These are hover, right-click, uploads, drag and drop (use **Swipe** with a target), tabs, frames, network faking,
storage, clock control, downloads, visual checkpoints and page performance. API, database, email and utility steps work in the same
test as usual. For example, one test can create a patient through the API, then check that it appears in the app.

Each step of a phone app waits up to **30 seconds** by default (browser steps: the setting in Settings), because
devices answer more slowly than a browser. A run's own step timeout, or a step's timeout, still applies.

## Evidence

Every test keeps:

- **Screenshots** at every step (or only at failures, as the run options say).
- A **screen recording** (MP4) of the whole test, made on the device.
- The **device log** (logcat) as the console log. A crash or an "app not responding" is marked as an error.
- At a failure, the **element tree** of the screen (XML): every element with its resource id, text, content
  description and bounds. It shows what the app displayed instead, and what to put in a locator.

## Manual tests

Manual tests of an Android app work from the run page: the tester uses the app on the phone or emulator and marks each
step there (pass, fail, notes, screenshots from the computer, bug reports). The panel that the browser and desktop
apps get, which opens the app beside the steps, is planned for native apps.

## Recording

**Record** on an Android or iOS app starts the app on the device and shows its screen in the dashboard, refreshed
about once a second. Use the app from there:

- **Click the screen** to tap. A text field gets the focus; type in **Text to type** and press **Type**, which records
  a **Fill** step. Typing again into the same field updates that step. Password fields become secrets
  (`{{secret.password}}`), as in the browser recorder.
- Choose what a click does: **Tap**, **Long press**, **Check text** (records a check of the text the element shows
  now) or **Check visible**.
- **Swipe** buttons, **Back** and **Hide keyboard**.

Each action is done in the app and recorded with ranked locators from the element tree: the resource id or
accessibility identifier first, then the label, hint or placeholder, the role with its text, the text, and XPath
last. Every locator is checked against the app before it is kept. An element without any id, text or label is not
recorded: the recorder explains why instead. Give the element an accessibility id in the app. **Stop & review** then
works as for the browser: edit, reorder, save as a new scenario or add to one.

## Diagnosis

A failed step in a phone app also looks at the device. The explanation then says:

- **the app crashed**: a crash in the device log, quoted;
- **the app was no longer on screen**: closed or in the background;
- **a dialog covered the app**: the dialog's text, for example a permission request. The fix suggests a **Handle
  dialog** or **Permission** step;
- **the element is below the visible screen**: add a **Scroll to** step;
- **the keyboard may cover the element**: add **Hide keyboard**;
- **the app did not start**: run `stepforge doctor native` and check the environment.

## Campaigns on several devices

Give each device its own environment (one emulator, one phone, one iPhone simulator…) and choose them in a campaign.
A campaign runs a phone app once per environment, with one combined report. The browsers and screen sizes of the
campaign only apply to web apps.

## Code export

**Exports** turns Android tests into an Appium project (Python + pytest, TypeScript + WebdriverIO, or Java + JUnit 5)
or Maestro flows, with the environment's app and emulator as capabilities and a GitHub Actions workflow that starts an
emulator. Each step keeps the Appium selectors StepForge uses, best first. See
[CODEGEN.md](CODEGEN.md#phone-and-desktop-apps-appium-maestro).

## Running in CI

The same tests run from the CLI (`stepforge run --app careclinic-mobile --env Emulator`). Linux CI runners can start an
Android emulator with hardware acceleration. StepForge's own CI runs its Android tests like this (GitHub Actions):

```yaml
- run: npm ci
- run: npm run appium:install
- name: Enable KVM
  run: |
    echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger --name-match=kvm
- uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 35
    arch: x86_64
    target: google_apis
    script: ./stepforge.sh run --app careclinic-mobile --env CI --junit results.xml
```

With the emulator already running, leave the environment's emulator and serial empty: StepForge uses the device that
is connected.

## The demo Android app

`demo/android-app` is **CareClinic mobile**, a small app used by StepForge's own tests:

- a sign-in screen: email, password, **Sign in**, and an error on a wrong password (demo account
  `nurse@careclinic.test` / `CareClinic1`);
- a patients screen: a name field, **Add patient**, a counter and the list.

It has one planted bug: names longer than 12 characters are cut short in the list. The built `careclinic.apk` is
in the folder, so you can try Android testing right away. Rebuild it from source with
`npx tsx scripts/build-android-demo.ts`, which uses the SDK's own tools (no Gradle).

## Troubleshooting

| Message | What to do |
| --- | --- |
| _Appium is not installed_ | `npm run appium:install`, or **Install Appium** on the Environments tab |
| _Set the app file (.apk) or the installed app's package_ | Edit the environment and fill in one of the two |
| _The app file was not found_ | Check the path. A relative path starts at StepForge's folder |
| _The Android app did not start: …_ | Run `stepforge doctor native`. Then check that the emulator name is right, the phone is unlocked and authorised (`adb devices` shows `device`, not `unauthorized`), and the APK is built for the device's processor |
| _No element found … Tried: testId=…_ | Open the failed step's element tree and check the element's resource id or text there |
| _"ui.hover" is not available in Android apps_ | The step is for web pages. Use another step or leave it out |
| A slow first test | Expected: the emulator boots and Appium installs its helper app once |
