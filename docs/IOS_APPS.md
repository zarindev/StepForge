# iOS apps

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge tests **native iOS apps** (iPhone and iPad) on the iOS Simulator or on a real iPhone. It uses the same
tests, runs, reports and diagnosis as web and Android apps. The steps go to the app through **Appium** and its
**XCUITest** driver, both open source (Apache-2.0). StepForge installs them into its own `data/tools` folder and starts
and stops them itself. No device cloud or paid account is needed.

**iOS apps can only be tested from a Mac.** Apple's tools (Xcode and the simulators) run only on macOS. On Windows and
Linux, StepForge's iOS checks say so.

This is step N3 of the [native apps plan](NATIVE_APPS_PLAN.md). It works like [Android apps](ANDROID_APPS.md): the same
steps, locators, evidence, gestures, [recording](ANDROID_APPS.md#recording),
[diagnosis](ANDROID_APPS.md#diagnosis) and [campaigns on several devices](ANDROID_APPS.md#campaigns-on-several-devices).

## What you need

| | Why | How to get it |
| --- | --- | --- |
| **Xcode** | Builds Appium's helper app, runs the simulators | The App Store (free, with an Apple ID) |
| **The iOS simulator platform** | The simulated iPhones | Xcode → Settings → Components → iOS |
| **Command-line tools that use Xcode** | Appium calls Xcode's tools | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` then `sudo xcodebuild -runFirstLaunch` |
| **Appium + XCUITest** | Drives the app | `npm run appium:install`, or **Install Appium** in StepForge (on a Mac it adds the iOS driver too) |

Check this Mac at any time:

```bash
./stepforge.sh doctor native --platform ios
```

```text
iOS — ready
  ✓ Xcode: Xcode 27.0
  ✓ Command-line tools use Xcode: /Applications/Xcode.app/Contents/Developer
  ✓ iOS simulators: 11: iPhone 17, iPhone 18 Pro, iPhone 18 Pro Max, iPhone 17e…
  ✓ Appium and the iOS driver: Appium 3.8.0, XCUITest 12.18.1 in data/tools/appium

Ready.
```

Every line marked ✗ says how to fix it. The same checks appear on an iOS app's **Environments** tab, with an
**Install Appium** button.

## Set up an iOS app

1. **Applications → New application**, then set **Platform** to _iOS app (iPhone, iPad)_.
2. **Add environment**. An iOS app's environment says which app and which device:

| Field | What to put |
| --- | --- |
| **App (.app or .ipa)** | A simulator build (the `.app` folder Xcode builds for "Any iOS Simulator", or a `.zip` of it), or an iPhone build (`.ipa`) |
| **or installed app's bundle id** | An app already on the simulator or iPhone, for example `com.example.app` |
| **Simulator** | A simulator by name, such as _iPhone 17_. Leave it empty to use the first iPhone simulator (a running one if any) |
| **iOS version** | Optional: picks the simulator with that iOS version when several have the same name |
| **or iPhone (device id)** | A real iPhone's id (Xcode → Window → Devices and Simulators). See _Real iPhones_ below |
| **Reset the app's data before each test** | On by default: every test starts fresh |
| **Show the simulator window** | Off by default: the simulator runs without a window |
| **Extra Appium capabilities** | Optional JSON for anything else XCUITest supports, for example `{ "appium:language": "fr", "appium:locale": "fr_FR" }` |

Variables and secrets work in every field, for example `{{env.appPath}}`. The **Base URL** is only a name for
reports, for example `app://careclinic`.

The first test after installing takes longer: Appium builds its helper app (WebDriverAgent) with Xcode once. It took
under a minute on an M3 Pro and can take several minutes on slower Macs. Later tests start in seconds.

## Writing tests

Tests use the same `ui.*` steps as web and Android apps. Locators are translated to iOS, best first:

| Locator | On iOS |
| --- | --- |
| **Test id** `sign_in` | The view's accessibility identifier (`accessibilityIdentifier` in UIKit, `.accessibilityIdentifier()` in SwiftUI, `testID` in React Native) |
| **Label** | The accessibility identifier, then the accessibility label |
| **Placeholder** `Email` | The text field's placeholder |
| **Text** `Sign in` | The label or value, exact, then containing it |
| **Role** `button "Sign in"` | Buttons, text fields (`textbox`, including secure fields), switches (`checkbox`, `switch`), pickers (`combobox`), images, links, static texts, tables… with that label or name |
| **XPath** | Used as is, against the screen's element tree (`XCUIElementTypeButton`…) |
| **Image** | A picture of the element, found on the screen ([image locators](IMAGE_LOCATORS.md)) |
| CSS | Not available: CSS is for web pages |

The steps work as on Android ([table](ANDROID_APPS.md#writing-tests)), with these differences:

- **Press a key:** `Enter`, `Tab`, `Backspace` and `Space` are typed into the step's element (or the focused field);
  `Home` presses the Home button. iPhones have no Back key: tap the app's own back button.
- **Check / Uncheck** reads a switch's value (`1` / `0`).
- **Scroll** swipes the screen.
- **Open (navigate)** opens a deep link such as `careclinic://patients/42`.
- **Gestures and device steps** work as on [Android](ANDROID_APPS.md#gestures-and-device-steps), with two
  differences. **Go back** taps the navigation bar's back button. **Permission** cannot grant `notifications` from
  outside the app: the app asks, and a **Handle dialog** step answers iOS's dialog (Allow). **Notification** sends a
  push notification on simulators once the app is allowed to show them.
- **Hide keyboard** uses the keyboard's Done or Return key; a keyboard without either says so.

## Evidence

Every test keeps:

- **Screenshots** at every step (or only at failures).
- A **screen recording** (MP4). On simulators StepForge records with Xcode's own tool (`simctl io recordVideo`), so
  nothing else is needed. On a real iPhone, Appium records it and needs `ffmpeg` installed (`brew install ffmpeg`).
- The **device log** (the iOS system log) as the console log. A crash is marked as an error.
- At a failure, the **element tree** of the screen (XML), with every element's type, name, label and value.

## Real iPhones

Simulators need nothing more than Xcode. A real iPhone also needs:

1. The iPhone connected by USB (or on the same network, paired in Xcode), unlocked, with **Developer Mode** on
   (Settings → Privacy & Security).
2. Appium's helper app signed for that iPhone. A free Apple ID works for development signing. Add your team to the
   environment's extra capabilities:
   `{ "appium:xcodeOrgId": "ABCDE12345", "appium:xcodeSigningId": "Apple Development" }`. The first run asks you to
   trust the developer on the iPhone (Settings → General → VPN & Device Management).
3. The app built for iPhones (`.ipa`), signed with the same team, or already installed (bundle id).

## Manual tests and recording

As for Android: manual tests of an iOS app are marked on the run page while the tester uses the simulator or iPhone.
**Record** shows the app's screen in the dashboard, and taps, typing, swipes and checks there become steps
([how](ANDROID_APPS.md#recording)).

## Code export

**Exports** turns iOS tests into an Appium project (Python + pytest, TypeScript + WebdriverIO, or Java + JUnit 5)
or Maestro flows, with the environment's app and simulator as capabilities and a GitHub Actions workflow on a macOS
runner. See [CODEGEN.md](CODEGEN.md#phone-and-desktop-apps-appium-maestro).

## Running in CI

GitHub's macOS runners come with Xcode and simulators. StepForge's own CI runs its iOS tests like this:

```yaml
runs-on: macos-latest
steps:
  - run: npm ci
  - run: npm run appium:install
  - run: ./stepforge.sh doctor native --platform ios
  - run: ./stepforge.sh run --app careclinic-ios --env Simulator --junit results.xml
```

## The demo iOS app

`demo/ios-app` is **CareClinic mobile** for iOS, the same app as the [Android demo](ANDROID_APPS.md#the-demo-android-app):
a sign-in screen (demo account `nurse@careclinic.test` / `CareClinic1`) and a patients screen, with the same planted
bug (names longer than 12 characters are cut short in the list). It is written in Swift (UIKit) and built for the
simulator with Xcode's own compiler, with no Xcode project:

```bash
npx tsx scripts/build-ios-demo.ts      # → demo/ios-app/build/CareClinic.app
```

## Troubleshooting

| Message | What to do |
| --- | --- |
| _Appium's iOS driver is not installed_ | `npm run appium:install` on the Mac, or **Install Appium** on the Environments tab |
| _No iPhone simulator found_ | Xcode → Settings → Components → iOS, or add a simulator in Xcode → Window → Devices and Simulators |
| _The iOS app did not start: … xcodebuild failed …_ | Run `stepforge doctor native --platform ios`. Check that the command-line tools use Xcode, and open Xcode once to finish its setup |
| _The app file was not found_ | Check the path. A simulator needs the `.app` built for the simulator, not an `.ipa` |
| No video on a real iPhone | Install ffmpeg (`brew install ffmpeg`) |
| _iPhones have no Back key_ | Tap the app's own back button (for example `role=button "Back"`) |
