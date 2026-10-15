import { StepError, type Locator } from '@stepforge/core';
import { findImage, pngFromDataUrl, type ImageMatch } from '@stepforge/image-match';
import { existsSync, readFileSync } from 'node:fs';
import type { ElementRef, WebDriverSession } from './webdriver.ts';

/** An image match stands in for an element: "image:x,y,width,height,score" in window coordinates. */
const PREFIX = 'image:';
export const isImageRef = (el: ElementRef | undefined): el is ElementRef => !!el && el.startsWith(PREFIX);

function parse(el: ElementRef) {
  const [x, y, width, height, score] = el.slice(PREFIX.length).split(',').map(Number) as number[];
  return {
    x: x!,
    y: y!,
    width: width!,
    height: height!,
    score: score!,
    cx: x! + width! / 2,
    cy: y! + height! / 2,
  };
}

/** The picture of an image locator: a PNG data URL, or a .png file path. */
export function pictureOf(l: Locator): Buffer {
  const png = pngFromDataUrl(l.value) ?? (existsSync(l.value) ? readFileSync(l.value) : undefined);
  if (!png)
    throw new StepError(
      'invalid_params',
      'An image locator needs a PNG picture (upload it in the step, or a .png path)',
    );
  return png;
}

/**
 * Looks for the picture on the screen now. A match is returned as an element reference in the window's
 * coordinates (screenshots are in pixels, which on phones and Retina screens are several per point).
 */
export async function findPicture(
  d: WebDriverSession,
  l: Locator,
): Promise<{ ref?: ElementRef; match: ImageMatch }> {
  const shot = await d.screenshot();
  const match = findImage(shot, pictureOf(l), { threshold: l.threshold ?? 0.9 });
  if (!match.found) return { match };
  const win = await d.windowSize().catch(() => null);
  const shotWidth = shot.readUInt32BE(16);
  const k = win?.width ? win.width / shotWidth : 1;
  const r = [match.x * k, match.y * k, match.width * k, match.height * k].map((v) => Math.round(v));
  return { ref: `${PREFIX}${r.join(',')},${match.score}`, match };
}

/**
 * The driver, with image matches usable like elements: taps, double taps, long presses and typing go to the
 * match's centre; "visible" is true (it was just found); text and attributes are explained as not available.
 */
export function withImages(d: WebDriverSession, pointerType: 'touch' | 'mouse'): WebDriverSession {
  const press = async (el: ElementRef, opts: { holdMs?: number; count?: number } = {}) => {
    const { cx, cy } = parse(el);
    const one = [
      { type: 'pointerMove', duration: 0, x: Math.round(cx), y: Math.round(cy), origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: opts.holdMs ?? 80 },
      { type: 'pointerUp', button: 0 },
    ];
    const actions = Array.from({ length: opts.count ?? 1 }, (_, i) => [
      ...(i ? [{ type: 'pause', duration: 100 }] : []),
      ...one,
    ]).flat();
    await d.actions([{ type: 'pointer', id: 'finger', parameters: { pointerType }, actions }]);
  };
  const typeText = async (text: string) => {
    const keys = [...text].flatMap((c) => [
      { type: 'keyDown', value: c },
      { type: 'keyUp', value: c },
    ]);
    if (keys.length) await d.actions([{ type: 'key', id: 'keyboard', actions: keys }]);
  };
  const noText = () => {
    throw new StepError(
      'invalid_params',
      'An image locator finds where to tap; to read text or attributes, use a locator with an id, text or label',
    );
  };
  return new Proxy(d, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown;
      if (typeof orig !== 'function') return orig;
      const call = (...args: unknown[]) => (orig as (...a: unknown[]) => unknown).apply(target, args);
      switch (prop) {
        case 'click':
          return (el: ElementRef) => (isImageRef(el) ? press(el) : call(el));
        case 'sendKeys':
          return async (el: ElementRef, text: string) => {
            if (!isImageRef(el)) return call(el, text);
            await press(el);
            await typeText(text);
          };
        case 'clear':
          // A picture of a field cannot be cleared: typing replaces nothing (use Type, or a field locator).
          return (el: ElementRef) => (isImageRef(el) ? Promise.resolve() : call(el));
        case 'displayed':
        case 'enabled':
          return (el: ElementRef) => (isImageRef(el) ? Promise.resolve(true) : call(el));
        case 'text':
        case 'attribute':
          return (el: ElementRef, ...rest: unknown[]) => (isImageRef(el) ? noText() : call(el, ...rest));
        case 'rect':
          return (el: ElementRef) => {
            if (!isImageRef(el)) return call(el);
            const { x, y, width, height } = parse(el);
            return Promise.resolve({ x, y, width, height });
          };
        case 'screenshot':
          // The match itself is not an element: a picture of the whole screen.
          return (el?: ElementRef) => (isImageRef(el) ? call() : call(el));
        case 'execute':
          return (script: string, args: unknown[] = [], timeoutMs?: number) => {
            const first = args[0] as { elementId?: string; duration?: number } | undefined;
            if (!isImageRef(first?.elementId)) return call(script, args, timeoutMs);
            const el = first.elementId;
            if (/double/i.test(script)) return press(el, { count: 2 });
            if (/longClick/i.test(script)) return press(el, { holdMs: first.duration ?? 1000 });
            if (/touchAndHold|press/i.test(script))
              return press(el, { holdMs: (first.duration ?? 1) * 1000 });
            if (/swipe/i.test(script)) {
              const { elementId: _drop, ...rest } = first;
              return call(script, [rest], timeoutMs);
            }
            throw new StepError(
              'unsupported',
              `"${script}" needs an element; an image locator gives only a place to tap`,
            );
          };
        default:
          return (orig as (...a: unknown[]) => unknown).bind(target);
      }
    },
  });
}
