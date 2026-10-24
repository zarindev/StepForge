import { StepError } from '@stepforge/core';
import { pressShortcut, type Direction, type NativePlatform, type PointerOptions } from './platforms.ts';
import { pngSize, type Area } from './view.ts';
import { WebDriverSession } from './webdriver.ts';

/** What the tester does on the dashboard's picture of the app (points are fractions of the picture, 0–1). */
export type ManualAction =
  | { action: 'tap'; x: number; y: number; button?: 'left' | 'right'; count?: number; holdMs?: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string }
  | { action: 'swipe'; direction: Direction }
  | { action: 'scroll'; direction: 'up' | 'down' }
  | { action: 'menu'; path: string }
  | { action: 'back' }
  | { action: 'hideKeyboard' };

/**
 * A manual test in a phone or desktop app: StepForge starts the app as tests do, the dashboard shows its screen and
 * passes on what the tester does there (taps and clicks go to the point, not to an element: nothing is recorded).
 * The whole session is a screen recording where the platform has one; screenshots come from the device or app.
 */
export class NativeManualSession {
  /** When the screen recording started (clips are offsets into it); undefined without a recording. */
  recordingStartedAt?: number;
  /** Why there is no recording (e.g. no ffmpeg), for the tester. */
  noRecording?: string;
  private stopRecording: (() => Promise<Buffer | null>) | null = null;
  private area?: Area;
  private busy: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private constructor(
    readonly driver: WebDriverSession,
    readonly platform: NativePlatform,
  ) {}

  static async start(opts: {
    url: string;
    platform: NativePlatform;
    /** Records the session's screen (off for automated tests of StepForge itself). */
    record?: boolean;
  }): Promise<NativeManualSession> {
    let driver: WebDriverSession;
    try {
      driver = await WebDriverSession.create(opts.url, opts.platform.capabilities(), 900_000);
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError(
        'navigation',
        `The ${opts.platform.name} app did not start: ${(err as Error).message}`,
      );
    }
    const s = new NativeManualSession(driver, opts.platform);
    if (opts.record !== false) {
      try {
        s.stopRecording = await opts.platform.record(driver);
        if (s.stopRecording) s.recordingStartedAt = Date.now();
        else s.noRecording = `No screen recording: the ${opts.platform.name} app could not be recorded here`;
      } catch (err) {
        s.noRecording = (err as Error).message;
      }
    }
    return s;
  }

  get kind() {
    return this.platform.kind;
  }

  /** One action at a time, in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new StepError('invalid_params', 'The app was closed'));
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  /** The screen (a desktop app's windows) as a PNG, and its size in pixels. */
  async screen(): Promise<{ png: Buffer; width: number; height: number }> {
    const { png, area } = await this.platform.view(this.driver);
    this.area = area;
    return { png, ...pngSize(png) };
  }

  /** A screenshot for a step's evidence: what the dashboard shows. */
  async screenshot(): Promise<Buffer> {
    return (await this.screen()).png;
  }

  /** A point of the picture (fractions) in the element tree's coordinates. */
  async point(fx: number, fy: number): Promise<{ x: number; y: number }> {
    if (!this.area) await this.screen();
    const a = this.area!;
    return { x: a.x + fx * a.width, y: a.y + fy * a.height };
  }

  act(a: ManualAction): Promise<void> {
    return this.serial(async () => {
      const d = this.driver;
      const pf = this.platform;
      switch (a.action) {
        case 'tap': {
          const { x, y } = await this.point(a.x, a.y);
          const opts: PointerOptions = {
            ...(a.button && { button: a.button }),
            ...(a.count && { count: a.count }),
            ...(a.holdMs && { holdMs: a.holdMs }),
          };
          if (pf.kind === 'phone' && a.button === 'right')
            throw new StepError('unsupported', 'Phones have no right-click: long-press instead');
          await pf.pointer(d, x, y, opts);
          break;
        }
        case 'type': {
          if (!a.text) return;
          // A phone types into the focused field; a desktop app gets the keys.
          const el = pf.kind === 'phone' ? await d.activeElement() : undefined;
          if (el) await d.sendKeys(el, a.text);
          else
            await d.actions([
              {
                type: 'key',
                id: 'keyboard',
                actions: [...a.text].flatMap((c) => [
                  { type: 'keyDown', value: c },
                  { type: 'keyUp', value: c },
                ]),
              },
            ]);
          break;
        }
        case 'key':
          if (pf.kind === 'desktop') await pressShortcut(d, a.key);
          else await pf.pressKey(d, a.key);
          break;
        case 'swipe':
          await pf.swipe(d, a.direction, 0.75);
          break;
        case 'scroll':
          await pf.scroll(d, a.direction);
          break;
        case 'menu':
          await pf.menu(
            d,
            a.path
              .split('>')
              .map((x) => x.trim())
              .filter(Boolean),
          );
          break;
        case 'back':
          await d.back();
          break;
        case 'hideKeyboard':
          await pf.hideKeyboard(d);
          break;
      }
    });
  }

  /** Closes the app; gives the session's screen recording (null without one). */
  async stop(): Promise<Buffer | null> {
    if (this.stopped) return null;
    this.stopped = true;
    await this.busy;
    const video = this.stopRecording ? await this.stopRecording().catch(() => null) : null;
    await this.driver.quit();
    return video?.length ? video : null;
  }
}
