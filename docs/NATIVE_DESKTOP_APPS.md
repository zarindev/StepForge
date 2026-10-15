# macOS, Windows and Linux desktop apps

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge tests **native desktop apps**: Mac apps (AppKit, SwiftUI, Catalyst) on a Mac, and Windows apps (Win32, WPF,
WinForms, UWP, WinUI) on Windows 10 or 11. They use the same tests, runs, reports and diagnosis as web and phone apps.
The steps go through **Appium**: its **Mac2** driver (Apple's XCTest) and its **NovaWindows** driver (Windows UI
Automation), both open source (Apache-2.0). StepForge installs and starts them itself, like the phone drivers.

Electron apps have their own, simpler support: see [DESKTOP_APPS.md](DESKTOP_APPS.md).

Linux apps (GTK, Qt) are covered too, through StepForge's own accessibility helper: see
[Linux apps](#linux-apps) below.

This is steps N5 and N6 of the [native apps plan](NATIVE_APPS_PLAN.md).

**Desktop tests use this computer's mouse and keyboard while they run.** Leave the computer alone during a run, or run
the tests in a separate user session, a virtual machine or CI.

## What you need

| | macOS apps | Windows apps |
| --- | --- | --- |
| Where | A Mac | Windows 10 or 11 |
| Tools | Xcode (free, App Store) | Windows PowerShell 5.1 (comes with Windows) |
| One-time setting | Automation Mode: `sudo automationmodetool enable-automationmode-without-authentication` | — |
| Appium driver | Mac2: `npm run appium:install` on the Mac | NovaWindows: `npm run appium:install` on Windows |

Check this computer at any time:

```bash
./stepforge.sh doctor native --platform macos      # on a Mac
stepforge.bat doctor native --platform windows     # on Windows
```

Automation Mode is macOS's switch that lets XCTest drive apps. Without it, macOS asks for your password at every test.
The first macOS test builds Appium's helper app (WebDriverAgentMac) with Xcode, which takes a minute or two. macOS may
also ask once to allow the helper to control the computer (System Settings → Privacy & Security → Accessibility).

## Set up an app

1. **Applications → New application**, then set **Platform** to _macOS app_ or _Windows app_.
2. **Add environment**:

| macOS field | What to put |
| --- | --- |
| **Bundle id** | An installed app, for example `com.apple.TextEdit` or `com.example.MyApp` |
| **or the app (.app)** | A build anywhere on the Mac, for example `/Users/me/build/MyApp.app` |
| **Arguments** / **App environment variables** | Passed to the app at launch |

| Windows field | What to put |
| --- | --- |
| **App** | The `.exe` (`C:\Program Files\MyApp\MyApp.exe`), or a Store app's id (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`) |
| **Arguments** / **Working folder** | Passed to the app at launch |

Variables and secrets work in every field. Each test starts the app and closes it at the end.

## Writing tests

The `ui.*` steps work as for other apps. Locators are translated to each system's accessibility tree:

| Locator | macOS (Mac2) | Windows (NovaWindows) |
| --- | --- | --- |
| **Test id** | Accessibility identifier (`setAccessibilityIdentifier`, `.accessibilityIdentifier()`) | AutomationId (WinForms: the control's `Name`; WPF: `AutomationProperties.AutomationId`) |
| **Label** | Accessibility identifier, then label or title | Name, then AutomationId |
| **Placeholder** | Placeholder value | The field's Name or HelpText |
| **Text** | Title, label or value (exact, then contained) | Name (exact, then contained) |
| **Role** `button "Save"` | Element type with that title or label (button, textbox, checkbox, radio, combobox, menuitem, text, link, list, tab…) | Control type with that Name (Button, Edit, CheckBox, RadioButton, ComboBox, MenuItem, Text, Hyperlink, List…) |
| **XPath** | Over `XCUIElementType…` elements | Over control types: `//Button[@Name='Save']` |
| **Image** | A picture of the element, found on the screen ([image locators](IMAGE_LOCATORS.md)) | The same |

Steps for desktop apps:

| Step | What it does |
| --- | --- |
| **Menu** (`ui.menu`) | Opens a menu path from the menu bar: `File > Save`, `Patients > Clear List` |
| **Press** a shortcut | `Meta+S` (⌘S on a Mac), `Control+S`, `Control+Shift+N`, `Alt+F4`, `F5`, `Enter`… (modifiers `Shift`, `Control`, `Alt` / `Option`, `Meta` / `Command`) |
| **Handle dialog** | Presses a dialog's button: OK or Cancel by default (on macOS, the alert's default or cancel button), or name it (`Clear`, `Yes`, `Don't Save`). If a click leaves a macOS sheet open, it answers with Return or Escape |
| **App** | `launch` or `close` the app |
| Click, double-click, fill, type, clear, check, select, assert, extract, wait for, screenshot, scroll | As for other apps |

Phone-only steps (swipe, long press on Windows, rotate, location, permissions, notifications) explain that they are
for phone apps. Web-page steps (tabs, network faking, storage…) explain that they are for browsers.

Each step waits up to **30 seconds** by default, as for phone apps; a run's or a step's own timeout still applies.

## Evidence

Screenshots (every step or at failures) and, at a failure, the element tree of the app (XML) with each element's
identifier, title, type and position. On macOS, a screen recording (MP4) is made with XCTest's own recorder (macOS 15
or newer). On Windows, a recording needs `ffmpeg` on the PATH. There is no device log for desktop apps: the console
evidence is empty.

## The demo apps

The same small **CareClinic** app as the phone demos: a sign-in window (`nurse@careclinic.test` / `CareClinic1`) and a
patients view, with a **Patients** menu (**Add Patient**, ⌘N / Ctrl+N; **Clear List**, which asks first). It has the
same planted bug: names longer than 12 characters are cut short.

| | Source | Build |
| --- | --- | --- |
| macOS | `demo/macos-app` (Swift, AppKit) | `npx tsx scripts/build-macos-demo.ts` → `demo/macos-app/build/CareClinic.app` (bundle id `com.stepforge.careclinic.mac`) |
| Windows | `demo/windows-app` (C#, WinForms) | `dotnet build demo/windows-app -c Release -o demo/windows-app/build` → `CareClinic.exe` (needs the .NET 8 SDK) |
| Linux | `demo/linux-app/careclinic.py` (Python, GTK 3) | No build: command `python3`, argument `demo/linux-app/careclinic.py` |

## Running in CI

GitHub's macOS and Windows runners can run desktop tests. StepForge's own CI does:

```yaml
# macOS
runs-on: macos-latest
steps:
  - run: npm ci && npm run appium:install
  - run: sudo automationmodetool enable-automationmode-without-authentication
  - run: ./stepforge.sh run --app careclinic-mac --env CI --junit results.xml

# Windows
runs-on: windows-latest
steps:
  - run: npm ci && npm run appium:install
  - run: stepforge.bat run --app careclinic-windows --env CI --junit results.xml
```

## Linux apps

StepForge tests **GTK and Qt apps on Linux** through the **AT-SPI** accessibility layer, the one Linux screen readers
use. Appium has no maintained Linux driver, so StepForge brings a small helper of its own
(`packages/executors/native/linux/stepforge_atspi.py`, Python, part of StepForge). It speaks the same WebDriver
protocol as Appium, so the steps, locators (including [image locators](IMAGE_LOCATORS.md)), checks, menus, dialogs
and screenshots work the same way.

**What you need:** Python 3 with PyGObject and the AT-SPI typelibs, and a display. On Ubuntu and Debian:

```bash
sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core
./stepforge.sh doctor native --platform linux
```

**Setting up:** set the application's **Platform** to _Linux app (GTK, Qt)_. In the environment, enter the app's
**Command** (a path, or a name on the PATH such as `gnome-calculator`), its **Arguments** (one per line), app
**environment variables** and a **working folder**. StepForge sets `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, so Qt apps
expose their controls too.

| Locator | On Linux (AT-SPI) |
| --- | --- |
| **Test id** | The accessible id: GTK `atk_object_set_accessible_id` (GTK 3, ATK 2.34+), Qt `objectName` |
| **Label**, **Placeholder** | The accessible name |
| **Text** | The accessible name, exact, then contained |
| **Role** `button "Save"` | The AT-SPI role with that name: `push_button`, `text`, `check_box`, `radio_button`, `combo_box`, `menu_item`, `label`, `link`, `list`, `page_tab`… |
| **XPath** | Over the accessibility tree, with role names as tags: `//push_button[@name='Save']` (ElementTree's XPath subset: paths and `[@attribute='value']`) |

Clicks use the element's own action (press, click, activate) when it has one, so they work without moving the real
mouse; typing sets the field's text through AT-SPI. **Menu** opens `Patients > Clear List` from the menu bar, and
**Handle dialog** presses a dialog's button.

**Limits:** screenshots need X11 (or apps under Xwayland); no screen recording or device log yet; recording Linux apps
from the dashboard is planned. On a server, run StepForge (or the CLI) inside a D-Bus session on a virtual display:
`dbus-run-session -- xvfb-run -a ./stepforge.sh run --app myapp --env CI`.

## Not yet

Recording desktop apps from the dashboard, and the manual-test panel inside a desktop app, are planned. For now, add
steps in the editor; the element tree from a failed run shows the identifiers and names to use. Linux desktop apps come
with step N6.

## Troubleshooting

| Message | What to do |
| --- | --- |
| _Appium's macOS driver is not installed_ / _Windows driver_ | `npm run appium:install` on that computer |
| macOS asks for a password at every test | Turn on Automation Mode (see above) |
| _The macOS app did not start: … xcodebuild failed …_ | `stepforge doctor native --platform macos`; open Xcode once; allow the helper in Privacy & Security → Accessibility |
| _No menu "File"_ | Use the menu's exact title as shown in the menu bar; on Windows, the app needs a standard menu bar (MenuStrip, Menu) |
| _Unknown key_ | Use the key names above, joined with `+` |
