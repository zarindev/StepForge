# What's new in StepForge

_By Md Zarin Tasnim · part of the StepForge documentation_

## Update — image locators

Some elements have nothing to find them by: a pin on a map, an icon in a canvas, a game, a remote desktop. An
**image locator** finds them by a small picture of them, in a screenshot, on web pages, Electron, Android, iOS,
macOS and Windows. Add it in a step's locators (**image** → **Choose picture**); clicks, hovers and taps happen at
the match, and visible / hidden checks look for it on the screen. A miss says how close the best place came (_best
match 62%, needs 90%_). Matching is built in (no OpenCV or other native install).
→ [Image locators](IMAGE_LOCATORS.md)

## Update — macOS and Windows desktop apps

StepForge now tests **native desktop apps**: Mac apps on a Mac and Windows apps (Win32, WPF, WinForms, UWP) on Windows
10 or 11, through Appium's Mac2 and NovaWindows drivers, which StepForge installs itself. Set an application's
platform to _macOS app_ or _Windows app_. Each environment then names the app (a bundle id or .app; an .exe or Store
app id). Tests use the same steps, plus **menus** (`File > Save`), **keyboard shortcuts** (`Meta+S`, `Control+N`) and
**dialog buttons**. `stepforge doctor native --platform macos|windows` checks the setup, including macOS's Automation
Mode. Demo apps: CareClinic for macOS (AppKit) and for Windows (WinForms), with the same planted bug as the phone apps.
→ [macOS and Windows apps](NATIVE_DESKTOP_APPS.md)

## Update — phone gestures, recording and diagnosis

Phone apps (Android and iOS) get their own steps: **swipe** (or drag one element onto another), **long press**,
**scroll to**, **go back**, **hide keyboard**, **rotate**, **open / close / background / reset the app**, **deep
links**, **location**, **permissions** and **push notifications** (iOS simulators). **Handle dialog** now answers a
dialog on a phone's screen, such as a permission request. The **recorder** shows the phone's screen in the dashboard:
click it to tap, type into fields, swipe, or add checks. Each action becomes a step with locators checked against
the app. When a step fails, the **diagnosis** now looks at the device too: the app crashed, it was no longer on
screen, a dialog covered it, the element was below the screen, or the keyboard covered it. **Campaigns** run a phone
app once per environment, so one campaign can cover several devices.
→ [Gestures](ANDROID_APPS.md#gestures-and-device-steps) · [Recording](ANDROID_APPS.md#recording) ·
[Diagnosis](ANDROID_APPS.md#diagnosis)

## Update — iOS apps

StepForge now tests **iPhone and iPad apps** on the iOS Simulator or a real iPhone, from a Mac with Xcode. Set an
application's platform to _iOS app_. Each environment then names the app (.app, .ipa or an installed bundle id) and
the simulator or iPhone. Appium's iOS driver is installed and run by StepForge, as for Android. The steps, locators
(accessibility ids, labels, placeholders, roles) and evidence (screen recording, system log, element tree) are the
same. On simulators the recording uses Xcode's own tool, so nothing else is needed. A demo app, CareClinic mobile for
iOS, is built with Xcode's compiler and has the same planted bug as the Android one.
→ [iOS apps](IOS_APPS.md)

## Update — Android apps

StepForge now tests **native Android apps** on an emulator or a USB phone, from Windows, macOS or Linux. Set an
application's platform to _Android app_. Each environment then names the app (an .apk, or an app already installed)
and the emulator or phone. StepForge installs Appium and its Android driver into its own folder and starts them
when needed. Test ids, text, hints, roles and XPath find elements. Every test keeps a screen recording, the device
log, screenshots and, at a failure, the screen's element tree. `stepforge doctor native` checks this computer and
says how to fix what is missing. A demo app, CareClinic mobile, has one planted bug to find.
→ [Android apps](ANDROID_APPS.md)

## Update — Electron desktop apps

StepForge now tests **Electron desktop apps** on Windows, macOS and Linux. Set an application's platform to
_Desktop app (Electron)_ and tell each environment how to start the app: the packaged executable or the project
folder, with arguments and environment variables. Tests run in the app's windows (a new window is like a new tab),
and recording, manual testing with the panel, video, traces and diagnosis all work as on the web. A small demo app,
`demo/desktop-app`, shows how.
→ [Desktop apps](DESKTOP_APPS.md)

## October 2026 release

**October 2026 — 13 new features**, all free, open source and running on your own computer. The full technical list
is in the [CHANGELOG](../CHANGELOG.md); every feature below links to its guide.

## Highlights

### 1. Manual testing in the browser
Tests are now **Automated** or **Manual**. Manual tests stay *pending* until a person runs them, and schedules,
campaigns and CI leave them out. **Run manually** opens your application in a browser with a StepForge panel on top:
the current step, the expected result and the next step, **Pass / Fail / Blocked / Skip**, notes, screenshots and
screen-recording clips. The whole session is recorded as the test's video, and the run page follows along live.
→ [Manual testing](MANUAL_RUNS.md)

### 2. Marked-up screenshots and bug reports
Draw on any screenshot — **boxes, circles, arrows, pen and text** in eight colours — and turn a failed step into a bug
report: how it should behave, how it behaves, severity, steps to reproduce and the screenshot, all filled in for you.
→ [Manual testing](MANUAL_RUNS.md#reporting-a-bug)

### 3. Visual checkpoints
The first run saves the approved screenshot; later runs compare pixels and show a red **difference image**. One click
accepts an intended change as the new baseline. Changing parts (clocks, ads) can be hidden first.
→ [Visual checkpoints](WEB_APPS.md#visual-checkpoints)

### 4. Any kind of web app
Wait for or **fake API responses**, go **offline**, check **downloads**, read and set **cookies and storage**,
**control the clock**, tap on **mobile web** with touch, click points on **canvas and maps** — and give each
environment its own language, time zone, location, dark mode, HTTP basic auth, headers, proxy, client certificates or
the installed Chrome / Edge.
→ [Testing every kind of web app](WEB_APPS.md)

### 5. Campaigns
A saved set of tests runs in every **environment × browser × screen size** you choose, with one click, one combined
report, and **Rerun failed** only where it failed — from the dashboard, a schedule or the CLI.
→ [Campaigns](CAMPAIGNS.md)

### 6. Reusable blocks with inputs
Write "Sign in" once and use it everywhere. **Make a block** from selected steps; fix the block once and every test that
uses it is repaired; failures are grouped by block.
→ [Blocks](BLOCKS.md)

### 7. Before / after each test
A block can run before and after every test of a module (and its sub-modules) or a single test. Clean-up runs even
when the test fails.
→ [Hooks](BLOCKS.md#hooks-before-and-after-each-test)

### 8. Element repository
Named, shared UI elements ("Save patient button") with ranked locators. Fix a locator once and every step follows; the
diagnosis's one-click fix updates the element.
→ [Elements](ELEMENTS.md)

### 9. Test data library
Rows from **tables, CSV files, read-only SQL queries or API calls** — the first, a random, a matching or a not-yet-used
row, previewed in any environment.
→ [Test data](TEST_DATA.md)

### 10. Conditions on the page
*If the cookie banner is visible → accept it.* *Repeat while "Load more" is shown → click it.* Visible, hidden,
present, enabled, text and count checks.
→ [Step reference](STEP_REFERENCE.md#utility-steps-util)

### 11. SOAP, Kafka and FTP
Call **SOAP** services with XPath checks and fault handling (XPath works on any XML response), send and wait for
**Kafka** messages, and upload, download and check files over **FTP, FTPS and SFTP** — in the same test as UI and
database steps.
→ [SOAP, Kafka and FTP](INTEGRATIONS.md)

### 12. Slack, Microsoft Teams and more
Run summaries go to **Slack, Microsoft Teams, Mattermost, Rocket.Chat**, Telegram, email or any **webhook**, with the
failed tests, their diagnosis and a link. Webhook URLs and header values are stored encrypted.
→ [Notifications](SCHEDULING.md#notifications)

### 13. Network breakdown and run queue priorities
Every test's traffic by type and host — third parties marked — with the slowest, largest and failed requests, and
**page-weight budgets** as test checks. Runs wait in a queue with **High / Normal / Low** priority and **Run next**.
→ [Network traffic](WEB_APPS.md#network-traffic) · [Run queue](FEATURES.md#run-tests)

## Quality

- A full review of the release found and fixed **45 bugs** before publishing, each with a regression test.
- **450 unit and integration tests** and **33 end-to-end tests** pass. Kafka is tested against a real Apache Kafka
  broker, SOAP, FTP and SFTP against servers started by the tests, and manual testing drives a real browser panel.
- On the demo applications StepForge still catches **25 of 25 planted bugs** and explains **24 of 25** correctly,
  with **0 false alarms** ([benchmarks](benchmarks.json)).
- Exported projects run against the demo app: Playwright (TypeScript, Python), Cypress, Selenium Python, pytest, k6,
  cURL and Postman, with and without page objects.

## Upgrading

Pull the latest version and start StepForge as usual: the database is backed up and upgraded automatically (your
tests, runs and settings are kept; existing tests become *Automated*). Visual baselines are now kept per application,
so a checkpoint saves a new baseline on its next run.

## Coming next

See [Coming next in the README](../README.md#coming-next) — native mobile and desktop apps lead the list
([plan](NATIVE_APPS_PLAN.md)).
