/**
 * Recording desktop apps, manual tests in phone and desktop apps, visual checkpoints and the Linux recording: checks
 * that need no device (fake drivers answer as Mac2, NovaWindows, the Linux helper, UiAutomator2 and XCUITest do).
 */
import { DEFAULT_RUN_OPTIONS, type StepContext } from '@stepforge/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  androidPlatform,
  appWindows,
  desktopCrop,
  elementAt,
  iosPlatform,
  kindOf,
  linuxPlatform,
  locatorsFor,
  macPlatform,
  NativeManualSession,
  NativeRecordingSession,
  parseElements,
  windowsPlatform,
  x11Recording,
  type NativePlatform,
} from '../src/index.ts';
import type { NativeRecordingSession as Recorder } from '../src/recorder.ts';
import { NativeSession } from '../src/session.ts';
import type { WebDriverSession as Driver } from '../src/webdriver.ts';

type Fake = Record<string, (...a: never[]) => unknown>;
const fake = (f: Fake, capabilities: Record<string, unknown> = {}) =>
  ({ capabilities, ...f }) as unknown as Driver;

/** A PNG of one colour, with an optional rectangle of another. */
function png(
  width: number,
  height: number,
  colour = [255, 255, 255],
  box?: { x: number; y: number; w: number; h: number; colour: number[] },
): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      const c = inBox ? box.colour : colour;
      const i = (y * width + x) * 4;
      img.data[i] = c[0]!;
      img.data[i + 1] = c[1]!;
      img.data[i + 2] = c[2]!;
      img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}
const sizeOf = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

// Mac2's page source: element types as tags, frames in points on the main display.
const MAC = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication elementType="2" identifier="" label="CareClinic" title="CareClinic" value="" enabled="true" selected="false" x="0" y="0" width="0" height="0">
  <XCUIElementTypeWindow elementType="4" identifier="main" label="" title="CareClinic" value="" enabled="true" selected="false" x="200" y="100" width="400" height="300">
    <XCUIElementTypeTextField elementType="49" identifier="email" label="" title="" value="" placeholderValue="Email" enabled="true" selected="false" x="220" y="130" width="360" height="24"/>
    <XCUIElementTypeSecureTextField elementType="50" identifier="password" label="" title="" value="" placeholderValue="Password" enabled="true" selected="false" x="220" y="160" width="360" height="24"/>
    <XCUIElementTypeButton elementType="9" identifier="" label="" title="Sign in" value="" enabled="true" selected="false" x="220" y="200" width="100" height="30"/>
    <XCUIElementTypeStaticText elementType="48" identifier="" label="" title="" value="No patients yet" enabled="true" selected="false" x="220" y="250" width="200" height="20"/>
  </XCUIElementTypeWindow>
  <XCUIElementTypeMenuBar elementType="54" identifier="" label="" title="" value="" enabled="true" selected="false" x="0" y="0" width="1440" height="24"/>
</XCUIElementTypeApplication>`;

// NovaWindows: control types as tags, positions from the app window's top-left corner.
const WINDOWS = `<?xml version="1.0" encoding="utf-8"?>
<Window AutomationId="MainForm" ClassName="WindowsForms10.Window" Name="CareClinic" IsOffscreen="False" IsPassword="False" LocalizedControlType="window" x="0" y="0" width="800" height="600">
  <Edit AutomationId="email" Name="Email" IsOffscreen="False" IsPassword="False" LocalizedControlType="edit" x="20" y="40" width="300" height="24"/>
  <Edit AutomationId="password" Name="Password" IsOffscreen="False" IsPassword="True" LocalizedControlType="edit" x="20" y="80" width="300" height="24"/>
  <Button AutomationId="" Name="Sign in" IsOffscreen="False" IsPassword="False" LocalizedControlType="button" x="20" y="120" width="100" height="30"/>
  <Button AutomationId="hidden" Name="Hidden" IsOffscreen="True" IsPassword="False" LocalizedControlType="button" x="20" y="120" width="100" height="30"/>
</Window>`;

// The Linux helper: AT-SPI roles as tags, screen positions.
const LINUX = `<application name="careclinic">
  <frame name="CareClinic" id="" description="" x="100" y="50" width="640" height="480" enabled="true" visible="true">
    <filler name="" id="" description="" x="100" y="50" width="640" height="480" enabled="true" visible="true">
      <text name="Email" id="email" description="" x="120" y="80" width="300" height="30" enabled="true" visible="true" />
      <password_text name="Password" id="" description="" x="120" y="120" width="300" height="30" enabled="true" visible="true" />
      <push_button name="Sign in" id="" description="" x="120" y="160" width="100" height="30" enabled="true" visible="true" />
    </filler>
  </frame>
  <dialog name="About" id="" description="" x="300" y="200" width="200" height="100" enabled="true" visible="true" />
</application>`;

describe('desktop element trees: the element under a click and its locators', () => {
  it('macOS (Mac2): identifiers, placeholders, titles and static texts', () => {
    const els = parseElements(MAC);
    expect(kindOf(els[1]!)).toBe('macOS');
    const field = elementAt(els, 300, 140)!;
    expect(locatorsFor(field)).toEqual([
      { strategy: 'testId', value: 'email', score: 95 },
      { strategy: 'placeholder', value: 'Email', score: 85 },
      { strategy: 'xpath', value: "//XCUIElementTypeTextField[@identifier='email']", score: 30 },
    ]);
    expect(locatorsFor(elementAt(els, 250, 215)!)).toEqual([
      { strategy: 'role', value: 'button', name: 'Sign in', score: 80 },
      { strategy: 'text', value: 'Sign in', score: 70 },
      { strategy: 'xpath', value: "//XCUIElementTypeButton[@title='Sign in']", score: 30 },
    ]);
    expect(locatorsFor(elementAt(els, 250, 255)!)[0]).toEqual({
      strategy: 'role',
      value: 'text',
      name: 'No patients yet',
      score: 80,
    });
    // An empty part of the window is the window (a container: no better element there).
    expect(elementAt(els, 590, 390)!.attrs.tag).toBe('XCUIElementTypeWindow');
  });

  it('Windows (NovaWindows): AutomationId, a field’s name as its label, off-screen elements skipped', () => {
    const els = parseElements(WINDOWS);
    expect(kindOf(els[0]!)).toBe('Windows');
    expect(locatorsFor(elementAt(els, 100, 50)!)).toEqual([
      { strategy: 'testId', value: 'email', score: 95 },
      { strategy: 'label', value: 'Email', score: 85 },
      { strategy: 'xpath', value: "//Edit[@AutomationId='email']", score: 30 },
    ]);
    const button = elementAt(els, 50, 130)!;
    expect(button.attrs.Name).toBe('Sign in');
    expect(locatorsFor(button)).toEqual([
      { strategy: 'role', value: 'button', name: 'Sign in', score: 80 },
      { strategy: 'text', value: 'Sign in', score: 70 },
      { strategy: 'xpath', value: "//Button[@Name='Sign in']", score: 30 },
    ]);
  });

  it('Linux (AT-SPI helper): accessible ids and names; a password field is a secret', () => {
    const els = parseElements(LINUX);
    expect(kindOf(els[0]!)).toBe('Linux');
    expect(locatorsFor(elementAt(els, 200, 90)!)).toEqual([
      { strategy: 'testId', value: 'email', score: 95 },
      { strategy: 'label', value: 'Email', score: 85 },
      { strategy: 'xpath', value: "//text[@id='email']", score: 30 },
    ]);
    expect(locatorsFor(elementAt(els, 150, 170)!)).toEqual([
      { strategy: 'role', value: 'button', name: 'Sign in', score: 80 },
      { strategy: 'text', value: 'Sign in', score: 70 },
      { strategy: 'xpath', value: "//push_button[@name='Sign in']", score: 30 },
    ]);
  });
});

describe('what the dashboard shows of a desktop app', () => {
  it('macOS: the app’s windows, cropped from a Retina screenshot (2 pixels per point)', () => {
    const windows = appWindows(parseElements(MAC), 'macOS');
    expect(windows).toEqual([{ x: 200, y: 100, width: 400, height: 300 }]);
    const { area, crop } = desktopCrop(
      windows,
      { x: 0, y: 0, width: 1440, height: 900 },
      { width: 2880, height: 1800 },
    );
    expect(area).toEqual({ x: 200, y: 100, width: 400, height: 300 });
    expect(crop).toEqual({ x: 400, y: 200, width: 800, height: 600 });
  });

  it('Linux: every top-level window (a dialog too); a window off the screen gives the whole screen', () => {
    const windows = appWindows(parseElements(LINUX), 'Linux');
    expect(windows).toHaveLength(2);
    const screen = { x: 0, y: 0, width: 1024, height: 768 };
    expect(desktopCrop(windows, screen, { width: 1024, height: 768 }).area).toEqual({
      x: 100,
      y: 50,
      width: 640,
      height: 480,
    });
    expect(desktopCrop([{ x: 5000, y: 0, width: 10, height: 10 }], screen, screen).area).toEqual(screen);
  });

  it('macOS view: the screenshot is cropped to the window, and fractions map to its points', async () => {
    const shot = png(2880, 1800, [0, 0, 0], { x: 400, y: 200, w: 800, h: 600, colour: [0, 200, 0] });
    const d = fake({
      screenshot: async () => shot,
      source: async () => MAC,
      windowRect: async () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const view = await macPlatform({ bundleId: 'com.x' }).view(d);
    expect(sizeOf(view.png)).toEqual({ width: 800, height: 600 });
    // Only the window's green, none of the black desktop.
    expect([...PNG.sync.read(view.png).data.subarray(0, 3)]).toEqual([0, 200, 0]);
    expect(view.area).toEqual({ x: 200, y: 100, width: 400, height: 300 });
  });
});

/** A recorder on a fake driver (sessions normally start through Appium). */
function recorder(driver: Driver, platform: NativePlatform): Recorder {
  const Ctor = NativeRecordingSession as unknown as new (...a: unknown[]) => Recorder;
  return new Ctor(driver, platform, { startUrl: '' });
}

describe('recording a desktop app from its picture', () => {
  const macDriver = (log: unknown[]) => {
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      email: { x: 220, y: 130, width: 360, height: 24 },
      password: { x: 220, y: 160, width: 360, height: 24 },
      signIn: { x: 220, y: 200, width: 100, height: 30 },
    };
    return fake({
      screenshot: async () => png(2880, 1800),
      source: async () => MAC,
      windowRect: async () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      findAll: async (_u: never, v: never) => {
        const q = v as string;
        if (q === 'email') return ['email'];
        if (q === 'password') return ['password'];
        if (q.includes('Sign in')) return ['signIn'];
        if (q.includes('Menu')) return ['menu'];
        return [];
      },
      rect: async (el: never) => rects[el],
      click: async (el: never) => void log.push(['click', el]),
      clear: async () => {},
      sendKeys: async (el: never, t: never) => void log.push(['keys', el, t]),
      execute: async (script: never, args: never) => void log.push([script, args]),
      actions: async (a: never) => void log.push(['actions', a]),
    });
  };
  // Fractions of the window picture: the window is 400×300 points at (200, 100).
  const at = (x: number, y: number) => [(x - 200) / 400, (y - 100) / 300] as const;

  it('macOS: clicks, typing (a secure field becomes a secret), double and right clicks, keys and menus', async () => {
    const log: unknown[] = [];
    const r = recorder(macDriver(log), macPlatform({ bundleId: 'com.x' }));
    await r.screen();
    expect(await r.click(...at(300, 140))).toEqual({ describe: 'TextField "Email"', field: true });
    await r.type('nurse@careclinic.test');
    await r.click(...at(300, 170));
    await r.type('CareClinic1');
    await r.click(...at(250, 215));
    await r.click(...at(250, 215), { count: 2 });
    await r.click(...at(250, 215), { button: 'right' });
    await r.key('Meta+S');
    await r.menu('File > New Patient');
    const steps = r.snapshot().steps;
    expect(steps.map((s) => s.type)).toEqual([
      'ui.fill',
      'ui.fill',
      'ui.click',
      'ui.dblclick',
      'ui.rightclick',
      'ui.press',
      'ui.menu',
    ]);
    expect(steps[0]!.locators![0]).toEqual({ strategy: 'testId', value: 'email', score: 95 });
    expect(steps[1]!.params).toEqual({ value: '{{secret.password}}' });
    expect(r.secrets).toEqual({ password: 'CareClinic1' });
    expect(steps[2]!.describe).toBe('Click Button "Sign in"');
    expect(steps[5]!.params).toEqual({ key: 'Meta+S' });
    expect(steps[6]!.params).toEqual({ path: 'File > New Patient' });
    expect(log).toContainEqual(['macos: doubleClick', [{ elementId: 'signIn' }]]);
    expect(log).toContainEqual(['macos: rightClick', [{ elementId: 'signIn' }]]);
    // The point of an element, as a fraction of the window picture.
    expect(await r.pointOf([{ strategy: 'testId', value: 'email' }])).toEqual({ x: 0.5, y: 42 / 300 });
  });

  it('Windows: a click maps into the app window (NovaWindows positions are from its corner)', async () => {
    const clicked: string[] = [];
    const d = fake({
      screenshot: async () => png(800, 600),
      source: async () => WINDOWS,
      windowRect: async () => ({ x: 300, y: 200, width: 800, height: 600 }),
      findAll: async (_u: never, v: never) => ((v as string).includes('Sign in') ? ['signIn'] : []),
      rect: async () => ({ x: 20, y: 120, width: 100, height: 30 }),
      click: async (el: never) => void clicked.push(el),
    });
    const r = recorder(d, windowsPlatform({ app: 'C:\\x.exe' }));
    await r.click(50 / 800, 130 / 600);
    expect(clicked).toEqual(['signIn']);
    expect(r.snapshot().steps[0]!.locators![0]).toEqual({
      strategy: 'role',
      value: 'button',
      name: 'Sign in',
      score: 80,
    });
  });
});

describe('manual tests in phone and desktop apps: the tester’s taps and clicks go to the point', () => {
  const manual = (driver: Driver, platform: NativePlatform) => {
    const Ctor = NativeManualSession as unknown as new (...a: unknown[]) => NativeManualSession;
    return new Ctor(driver, platform);
  };

  it('macOS: clicks at the point in the window (main-display points), right and double clicks', async () => {
    const calls: unknown[] = [];
    const d = fake({
      screenshot: async () => png(2880, 1800),
      source: async () => MAC,
      windowRect: async () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      execute: async (s: never, a: never) => void calls.push([s, a]),
      actions: async (a: never) => void calls.push(['actions', a]),
    });
    const m = manual(d, macPlatform({ bundleId: 'com.x' }));
    expect(sizeOf(await m.screenshot())).toEqual({ width: 800, height: 600 });
    await m.act({ action: 'tap', x: 0.5, y: 0.5 });
    await m.act({ action: 'tap', x: 0.25, y: 0.5, button: 'right' });
    await m.act({ action: 'tap', x: 0.25, y: 0.5, count: 2 });
    await m.act({ action: 'type', text: 'ab' });
    expect(calls.slice(0, 3)).toEqual([
      ['macos: click', [{ x: 400, y: 250 }]],
      ['macos: rightClick', [{ x: 300, y: 250 }]],
      ['macos: doubleClick', [{ x: 300, y: 250 }]],
    ]);
    expect(JSON.stringify(calls[3])).toContain('"keyDown","value":"a"');
  });

  it('Windows: the click goes to the screen position (the window’s place plus the point)', async () => {
    const calls: unknown[] = [];
    const d = fake({
      screenshot: async () => png(800, 600),
      source: async () => WINDOWS,
      windowRect: async () => ({ x: 300, y: 200, width: 800, height: 600 }),
      execute: async (s: never, a: never) => void calls.push([s, a]),
    });
    const m = manual(d, windowsPlatform({ app: 'C:\\x.exe' }));
    await m.act({ action: 'tap', x: 0.5, y: 0.5, button: 'right' });
    expect(calls).toEqual([['windows: click', [{ x: 700, y: 500, button: 'right', times: 1 }]]]);
  });

  it('Linux: W3C mouse actions at screen positions, button 2 for a right-click', async () => {
    const actions: unknown[] = [];
    const d = fake({
      screenshot: async () => png(1024, 768),
      source: async () => LINUX,
      windowRect: async () => ({ x: 0, y: 0, width: 1024, height: 768 }),
      actions: async (a: never) => void actions.push(a),
    });
    const m = manual(d, linuxPlatform({ app: 'careclinic' }));
    await m.screen();
    await m.act({ action: 'tap', x: 0.5, y: 0.5, button: 'right' });
    const pointer = (
      actions[0] as { actions: { type: string; x?: number; y?: number; button?: number }[] }[]
    )[0]!;
    expect(pointer.actions[0]).toMatchObject({ type: 'pointerMove', x: 420, y: 290 });
    expect(pointer.actions[1]).toEqual({ type: 'pointerDown', button: 2 });
  });

  it('phones: a tap is a touch at the point; typing goes to the focused field; no right-click', async () => {
    const calls: unknown[] = [];
    const d = fake({
      screenshot: async () => png(1080, 2400),
      activeElement: async () => 'field',
      sendKeys: async (el: never, t: never) => void calls.push(['keys', el, t]),
      actions: async (a: never) => void calls.push(['actions', a]),
    });
    const m = manual(d, androidPlatform({ appPackage: 'com.x' }));
    await m.act({ action: 'tap', x: 0.5, y: 0.25, holdMs: 1000 });
    await m.act({ action: 'type', text: 'Hi' });
    const tap = (calls[0] as [string, { parameters: unknown; actions: unknown[] }[]])[1][0]!;
    expect(tap.parameters).toEqual({ pointerType: 'touch' });
    expect(tap.actions).toContainEqual({
      type: 'pointerMove',
      duration: 0,
      x: 540,
      y: 600,
      origin: 'viewport',
    });
    expect(tap.actions).toContainEqual({ type: 'pause', duration: 1000 });
    expect(calls[1]).toEqual(['keys', 'field', 'Hi']);
    await expect(m.act({ action: 'tap', x: 0.5, y: 0.5, button: 'right' })).rejects.toThrow(/long-press/);
  });

  it('iOS: positions are points (the window size), not the screenshot’s pixels', async () => {
    const calls: unknown[] = [];
    const d = fake({
      screenshot: async () => png(1206, 2622),
      windowSize: async () => ({ width: 402, height: 874 }),
      actions: async (a: never) => void calls.push(a),
    });
    const m = manual(d, iosPlatform({ bundleId: 'com.x', udid: 'X' }));
    await m.act({ action: 'tap', x: 0.5, y: 0.5 });
    expect(JSON.stringify(calls[0])).toContain('"x":201,"y":437');
  });
});

describe('visual checkpoints in apps', () => {
  const run = (driver: Driver, options: Record<string, unknown>, baselineDir: string) => {
    const ctx = {
      runId: 'R',
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-visual-')),
      options: { ...DEFAULT_RUN_OPTIONS, ...options },
      signal: new AbortController().signal,
      shared: new Map(),
      startedAt: Date.now(),
      log: () => {},
      timeoutMs: 1000,
      stepIndex: 0,
    } as unknown as StepContext;
    const s = new NativeSession(ctx, async () => '', { baselineDir });
    (s as unknown as { driver: unknown }).driver = driver;
    const step = {
      id: 'step-1',
      type: 'ui.visualCheckpoint',
      params: {},
      locators: [],
      position: 0,
    } as never;
    return () => s.execute(step, ctx);
  };

  it('a phone: a new baseline, a match, then a change; the status bar (its clock) is left out', async () => {
    const baselines = mkdtempSync(join(tmpdir(), 'sf-baselines-'));
    let shot = png(100, 200, [255, 255, 255], { x: 0, y: 0, w: 100, h: 20, colour: [0, 0, 0] });
    const d = fake(
      {
        screenshot: async () => shot,
        execute: async (script: never) =>
          (script as string) === 'mobile: getSystemBars' ? { statusBar: { height: 20 } } : null,
      },
      { deviceModel: 'sdk_gphone64_arm64' },
    );
    const check = run(d, { android: { appPackage: 'com.x' } }, baselines);
    const first = await check();
    expect(first.visual).toMatchObject({
      status: 'new',
      key: 'step-1-android-sdk_gphone64_arm64-100x180.png',
    });
    // Only the clock changed: still a match.
    shot = png(100, 200, [255, 255, 255], { x: 0, y: 0, w: 100, h: 20, colour: [9, 9, 9] });
    expect((await check()).visual).toMatchObject({ status: 'match', diffPercent: 0 });
    // The app's own content changed: the check fails, with a difference image.
    shot = png(100, 200, [255, 255, 255], { x: 10, y: 50, w: 50, h: 50, colour: [255, 0, 0] });
    const changed = await check();
    expect(changed.visual).toMatchObject({ status: 'changed' });
    expect(changed.visual!.diff).toMatch(/visual-000-diff\.png$/);
    expect(changed.assertions![0]!.passed).toBe(false);
  });

  it('a desktop app: the app’s windows, keyed by platform and size', async () => {
    const baselines = mkdtempSync(join(tmpdir(), 'sf-baselines-'));
    const d = fake({
      screenshot: async () => png(2880, 1800),
      source: async () => MAC,
      windowRect: async () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const out = await run(d, { macos: { bundleId: 'com.x' } }, baselines)();
    expect(out.visual).toMatchObject({ status: 'new', key: 'step-1-macos-800x600.png' });
  });
});

describe('Linux screen recording', () => {
  it('explains what is missing: a display, or ffmpeg', async () => {
    const d = fake({ windowRect: async () => ({ x: 0, y: 0, width: 1024, height: 768 }) });
    await expect(x11Recording(d, '')).rejects.toThrow(/no X display/);
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(x11Recording(d, ':99')).rejects.toThrow(/install ffmpeg/);
    } finally {
      process.env.PATH = path;
    }
  });
});
