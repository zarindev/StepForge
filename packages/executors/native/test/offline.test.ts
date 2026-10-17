/** Native executor checks that need no device: fake drivers and a fake Appium answer. */
import { DEFAULT_RUN_OPTIONS, StepError, type StepContext } from '@stepforge/core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Ios from '../src/ios.ts';
import type { NativeRecordingSession as Recorder } from '../src/recorder.ts';
import type { WebDriverSession as Driver } from '../src/webdriver.ts';

vi.mock('../src/ios.ts', async (orig) => ({
  ...(await orig<typeof Ios>()),
  listSimulators: () => [
    { udid: 'A', name: 'iPhone 17', runtime: 'iOS 26.0', state: 'Shutdown' },
    { udid: 'B', name: 'iPad Air', runtime: 'iOS 18.2', state: 'Shutdown' },
    { udid: 'C', name: 'iPhone 15', runtime: 'iOS 18.2', state: 'Shutdown' },
  ],
}));

const {
  APPIUM_VERSION,
  appiumInstalled,
  emulatorImage,
  iosCapabilities,
  linuxQueries,
  macPlatform,
  macQueries,
  NativeRecordingSession,
  parseJavaMajor,
  tarCommand,
  wantedDrivers,
  windowsPlatform,
  androidPlatform,
  WebDriverError,
  WebDriverSession,
} = await import('../src/index.ts');
const { classChainLiteral } = await import('../src/locators.ts');
const { NativeSession } = await import('../src/session.ts');

type Fake = Record<string, (...a: never[]) => unknown>;
const fake = (f: Fake) => f as unknown as Driver;

describe('locators with awkward names', () => {
  it('macOS class chains double a backtick; Linux falls back to the exact name when both quotes appear', () => {
    expect(classChainLiteral('a`b"c')).toBe('"a``b\\"c"');
    expect(macQueries({ strategy: 'role', value: 'button', name: 'Run `ls`' })[0]!.value).toBe(
      '**/XCUIElementTypeButton[`title == "Run ``ls``" OR label == "Run ``ls``" OR placeholderValue == "Run ``ls``"`]',
    );
    expect(linuxQueries({ strategy: 'role', value: 'button', name: `Tom's "best"` })).toEqual([
      { using: 'name', value: `Tom's "best"` },
    ]);
    expect(linuxQueries({ strategy: 'role', value: 'button', name: "Tom's" })[0]).toEqual({
      using: 'xpath',
      value: `//push_button[@name="Tom's"]`,
    });
  });
});

describe('launch settings and set-up checks', () => {
  it('iOS: the iOS version picks the first iPhone simulator of that runtime', () => {
    expect(iosCapabilities({ bundleId: 'x', platformVersion: '18.2' })).toMatchObject({
      'appium:udid': 'C',
      'appium:deviceName': 'iPhone 15',
      'appium:platformVersion': '18.2',
    });
    expect(iosCapabilities({ bundleId: 'x', platformVersion: '18' })['appium:udid']).toBe('C');
    expect(iosCapabilities({ bundleId: 'x' })['appium:udid']).toBe('A');
    expect(() => iosCapabilities({ bundleId: 'x', platformVersion: '17.5' })).toThrow(
      /No iPhone simulator with iOS 17.5/,
    );
  });

  it('reads Java versions, picks the emulator image for the processor and Windows’ own tar', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
    expect(parseJavaMajor('openjdk version "17" 2021-09-14')).toBe(17);
    expect(parseJavaMajor('nothing')).toBeUndefined();
    expect(emulatorImage('arm64')).toMatch(/arm64-v8a$/);
    expect(emulatorImage('x64')).toMatch(/x86_64$/);
    expect(tarCommand('darwin')).toBe('tar');
    const root = mkdtempSync(join(tmpdir(), 'sf-win-'));
    mkdirSync(join(root, 'System32'));
    writeFileSync(join(root, 'System32', 'tar.exe'), '');
    expect(tarCommand('win32', { SystemRoot: root })).toBe(join(root, 'System32', 'tar.exe'));
    expect(tarCommand('win32', { SystemRoot: join(root, 'none') })).toBe('tar');
  });

  it('Appium counts as installed only at the pinned versions (a driver alone: any version)', () => {
    const tools = mkdtempSync(join(tmpdir(), 'sf-appium-'));
    const pkg = join(tools, 'appium', 'node_modules', 'appium');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'index.js'), '');
    // A portable Node.js, for when this one is outside Appium's range.
    const node = join(tools, 'node', ...(process.platform === 'win32' ? [] : ['bin']));
    mkdirSync(node, { recursive: true });
    writeFileSync(join(node, process.platform === 'win32' ? 'node.exe' : 'node'), '');
    const cache = join(tools, 'appium', 'home', 'node_modules', '.cache', 'appium');
    mkdirSync(cache, { recursive: true });
    const write = (appium: string, driverVersion: (pinned: string) => string) => {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: appium }));
      writeFileSync(
        join(cache, 'extensions.yaml'),
        `drivers:\n${wantedDrivers()
          .map((d) => `  ${d.name}:\n    automationName: X\n    version: ${driverVersion(d.version)}\n`)
          .join('')}schemaRev: 4\n`,
      );
    };
    write(APPIUM_VERSION, (v) => v);
    expect(appiumInstalled(tools)).toBe(true);
    write('3.0.0', (v) => v);
    expect(appiumInstalled(tools)).toBe(false);
    write(APPIUM_VERSION, () => '1.0.0');
    expect(appiumInstalled(tools)).toBe(false);
    expect(appiumInstalled(tools, 'uiautomator2')).toBe(true);
  });
});

describe('desktop dialogs and scrolling', () => {
  it('macOS: no sheet or dialog open → "no such alert", and no button of the app is pressed', async () => {
    const clicked: string[] = [];
    const d = fake({
      findAll: async (_u: never, v: never) =>
        (v as string).includes('XCUIElementTypeButton') ? ['app-ok'] : [],
      click: async (el: never) => void clicked.push(el),
    });
    const mac = macPlatform({ bundleId: 'com.x' });
    await expect(mac.dialog(d, true)).rejects.toThrow(/no such alert/);
    expect(clicked).toEqual([]);
  });

  it('macOS: a dialog’s button is searched inside the sheet or dialog', async () => {
    const queries: string[] = [];
    let open = true;
    const d = fake({
      findAll: async (_u: never, v: never) => {
        queries.push(v);
        const q = v as string;
        if (!open) return [];
        if (q === '**/XCUIElementTypeSheet') return ['sheet'];
        return q.startsWith('**/XCUIElementTypeSheet/**/XCUIElementTypeButton') ? ['ok'] : [];
      },
      click: async () => void (open = false),
    });
    await macPlatform({ bundleId: 'com.x' }).dialog(d, true);
    expect(queries).toContain('**/XCUIElementTypeSheet/**/XCUIElementTypeButton[`title == "OK"`]');
  });

  it('Windows: only buttons of a modal or owned window count', async () => {
    let query = '';
    const d = fake({ findAll: async (_u: never, v: never) => ((query = v), []) });
    await expect(windowsPlatform({ app: 'x' }).dialog(d, false)).rejects.toThrow(/no such alert/);
    expect(query).toContain(`//Window[@IsModal='True']//Button[@Name='Cancel']`);
    expect(query).not.toMatch(/^\/\/Window\/\/Button/);
  });

  it('macOS scrolls at the centre of the app window', async () => {
    const calls: unknown[] = [];
    const d = fake({
      findAll: async () => ['win'],
      rect: async () => ({ x: 100, y: 50, width: 800, height: 600 }),
      execute: async (script: never, args: never) => void calls.push([script, args]),
    });
    await macPlatform({ bundleId: 'com.x' }).scroll(d, 'down');
    expect(calls).toEqual([['macos: scroll', [{ x: 500, y: 350, deltaX: 0, deltaY: -200 }]]]);
  });
});

describe('cancelling a run', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it('stops waiting for a session at once, and quits a session Appium starts after the cancel', async () => {
    const deleted: string[] = [];
    let answer: (() => void) | undefined;
    const server = createServer((req, res) => {
      if (req.method === 'DELETE') {
        deleted.push(req.url!);
        res.end('{"value":null}');
        return;
      }
      answer = () => res.end(JSON.stringify({ value: { sessionId: 'late', capabilities: {} } }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ac = new AbortController();
    const created = WebDriverSession.create(url, {}, 30_000, ac.signal);
    await vi.waitFor(() => expect(answer).toBeDefined());
    ac.abort();
    await expect(created).rejects.toMatchObject({ kind: 'aborted' });
    answer!();
    await vi.waitFor(() => expect(deleted).toEqual(['/session/late']));
  });

  const session = (driver: Fake) => {
    const ac = new AbortController();
    const ctx = {
      runId: 'R',
      artifactsDir: tmpdir(),
      options: { ...DEFAULT_RUN_OPTIONS, android: { appPackage: 'com.x' } },
      signal: ac.signal,
      shared: new Map(),
      startedAt: Date.now(),
      log: () => {},
      timeoutMs: 20_000,
      stepIndex: 0,
    } as unknown as StepContext;
    const s = new NativeSession(ctx, async () => '');
    (s as unknown as { driver: unknown }).driver = driver;
    return { s, ctx, ac };
  };
  const step = (
    type: string,
    params: Record<string, unknown>,
    locators = [{ strategy: 'testId', value: 'x' }],
  ) => ({ id: 's', type, params, locators, position: 0 }) as never;

  it('an assert stops polling when the run is cancelled', async () => {
    const { s, ctx, ac } = session({ findAll: async () => [] });
    setTimeout(() => ac.abort(), 100);
    const t = Date.now();
    await expect(s.execute(step('ui.assert', { check: 'text', expected: 'Hi' }), ctx)).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('waiting for a dialog stops when the run is cancelled', async () => {
    const { s, ctx, ac } = session({
      execute: async () => {
        throw new WebDriverError('no such alert', 'An attempt was made to operate on a modal dialog');
      },
    });
    setTimeout(() => ac.abort(), 100);
    const t = Date.now();
    await expect(s.execute(step('ui.handleDialog', {}, []), ctx)).rejects.toBeInstanceOf(StepError);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('recording a phone app: the element under the tap', () => {
  // A list whose rows repeat the same id and text; the second row is tapped.
  const LIST = `<hierarchy width="1080" height="2400">
  <android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <android.widget.Button class="android.widget.Button" resource-id="com.x:id/open" text="Open" clickable="true" bounds="[0,100][1080,200]" />
    <android.widget.Button class="android.widget.Button" resource-id="com.x:id/open" text="Open" clickable="true" bounds="[0,200][1080,300]" />
    <android.widget.Button class="android.widget.Button" resource-id="com.x:id/help" text="Help" clickable="true" bounds="[0,2300][1080,2400]" />
  </android.widget.FrameLayout>
</hierarchy>`;
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
    row1: { x: 0, y: 100, width: 1080, height: 100 },
    row2: { x: 0, y: 200, width: 1080, height: 100 },
    help: { x: 0, y: 2300, width: 1080, height: 100 },
  };
  const recorder = (clicked: string[]) => {
    const driver = fake({
      source: async () => LIST,
      screenshot: async () => png(1080, 2400),
      // The window leaves out the navigation bar.
      windowSize: async () => ({ width: 1080, height: 2274 }),
      findAll: async (using: never, value: never) => {
        const v = value as string;
        if (v.includes('help')) return ['help'];
        if (using === 'xpath' || v.includes('open') || v.includes('Open')) return ['row1', 'row2'];
        return [];
      },
      rect: async (el: never) => rects[el],
      click: async (el: never) => void clicked.push(el),
    });
    // The constructor is private (sessions start through Appium): built directly on the fake driver.
    const Ctor = NativeRecordingSession as unknown as new (...a: unknown[]) => Recorder;
    return new Ctor(driver, androidPlatform({ appPackage: 'com.x' }), { startUrl: '' });
  };

  it('taps the row under the point, with its position as the locator (not the first row’s id)', async () => {
    const clicked: string[] = [];
    const r = recorder(clicked);
    await r.tap(0.5, 250 / 2400);
    expect(clicked).toEqual(['row2']);
    expect(r.snapshot().steps[0]!.locators).toEqual([
      {
        strategy: 'xpath',
        value: "(//android.widget.Button[@resource-id='com.x:id/open'])[2]",
        score: 20,
      },
    ]);
  });

  it('Android: screen fractions are of the screenshot (the window size leaves out the system bars)', async () => {
    const clicked: string[] = [];
    const r = recorder(clicked);
    await r.screen();
    // The bottom row is beyond the window's height: only the screenshot's size reaches it.
    const hit = await r.inspect(0.5, 2350 / 2400);
    expect(hit?.element.attrs.text).toBe('Help');
    expect(hit?.locators[0]).toEqual({ strategy: 'testId', value: 'help', score: 95 });
  });
});
