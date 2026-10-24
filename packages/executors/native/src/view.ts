import { cropPng } from '@stepforge/image-match/visual';
import { parseElements, type ScreenElement } from './recorder.ts';
import type { WebDriverSession } from './webdriver.ts';

/** A rectangle in the element tree's coordinates (pixels on Android and Windows, points on iOS and macOS). */
export type Area = { x: number; y: number; width: number; height: number };

/** What the dashboard shows of an app: a PNG, and the part of the element tree's coordinates it covers. */
export type AppView = { png: Buffer; area: Area };

export const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The smallest rectangle around all of them (undefined for none). */
export function union(rects: Area[]): Area | undefined {
  const r = rects.filter((a) => a.width > 0 && a.height > 0);
  if (!r.length) return undefined;
  const x = Math.min(...r.map((a) => a.x));
  const y = Math.min(...r.map((a) => a.y));
  const right = Math.max(...r.map((a) => a.x + a.width));
  const bottom = Math.max(...r.map((a) => a.y + a.height));
  return { x, y, width: right - x, height: bottom - y };
}

function intersect(a: Area, b: Area): Area | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * The app's own windows in a desktop element tree: macOS windows (XCUIElementTypeWindow, sheets included), the
 * Linux helper's top-level frames and dialogs, the Windows app window (the tree's root).
 */
export function appWindows(elements: ScreenElement[], platform: 'macOS' | 'Windows' | 'Linux'): Area[] {
  const windows =
    platform === 'macOS'
      ? elements.filter((e) => e.attrs.tag === 'XCUIElementTypeWindow')
      : platform === 'Linux'
        ? elements.filter((e) => e.depth === Math.min(...elements.map((x) => x.depth)))
        : elements.filter((e) => e.depth === 0);
  return windows.filter((e) => e.attrs.visible !== 'false').map((e) => e.rect);
}

/**
 * Which part of a desktop screenshot shows the app: its windows, clipped to what the screenshot covers (`screen`, in
 * the tree's coordinates). A Retina screenshot has two (or more) pixels per point: the crop is in pixels, the area in
 * points. With no window on that screen, the whole screenshot.
 */
export function desktopCrop(
  windows: Area[],
  screen: Area,
  shot: { width: number; height: number },
): { area: Area; crop: Area } {
  const k = shot.width / screen.width;
  const all = union(windows);
  const area = all && intersect(all, screen);
  if (!area) return { area: screen, crop: { x: 0, y: 0, width: shot.width, height: shot.height } };
  return {
    area,
    crop: {
      x: (area.x - screen.x) * k,
      y: (area.y - screen.y) * k,
      width: area.width * k,
      height: area.height * k,
    },
  };
}

/**
 * A desktop app's view: the screenshot, cropped to the app's windows. `screen` is what the screenshot covers in the
 * tree's coordinates: macOS's main display in points, the Linux root window, the Windows app window (NovaWindows
 * takes its screenshot of the app's window and gives positions from its top-left corner).
 */
export async function desktopView(
  d: WebDriverSession,
  platform: 'macOS' | 'Windows' | 'Linux',
): Promise<AppView> {
  const [png, source, rect] = await Promise.all([d.screenshot(), d.source(), d.windowRect()]);
  const shot = pngSize(png);
  const elements = parseElements(source);
  const screen: Area =
    platform === 'Windows'
      ? { x: 0, y: 0, width: rect.width || shot.width, height: rect.height || shot.height }
      : {
          x: rect.x ?? 0,
          y: rect.y ?? 0,
          width: rect.width || shot.width,
          height: rect.height || shot.height,
        };
  if (platform === 'Windows') return windowsView(png, elements, screen, shot);
  const { area, crop } = desktopCrop(appWindows(elements, platform), screen, shot);
  return { png: cropPng(png, crop), area };
}

/**
 * A Windows app's view. NovaWindows' screenshot is the window's rectangle, which includes Windows' invisible resize
 * border at the sides and bottom: what is behind the window shows there (and changes). The title bar spans exactly
 * the visible width, so its offset is the border's width.
 */
export function windowsView(
  png: Buffer,
  elements: ScreenElement[],
  screen: Area,
  shot: { width: number; height: number },
): AppView {
  const top = Math.min(...elements.map((e) => e.depth));
  const bar = elements.find((e) => e.depth === top + 1 && e.attrs.tag === 'TitleBar');
  const border = bar ? Math.round(bar.rect.x) : 0;
  if (border <= 0 || border > 20 || screen.width - 2 * border < 50 || screen.height - border < 50)
    return { png, area: screen };
  const area = { x: border, y: 0, width: screen.width - 2 * border, height: screen.height - border };
  const sx = shot.width / screen.width;
  const sy = shot.height / screen.height;
  return {
    png: cropPng(png, { x: area.x * sx, y: 0, width: area.width * sx, height: area.height * sy }),
    area,
  };
}

/** A phone's view: the whole screen; Android positions are the screenshot's pixels, iOS's are points. */
export async function phoneView(d: WebDriverSession, platform: 'Android' | 'iOS'): Promise<AppView> {
  const png = await d.screenshot();
  const size = pngSize(png);
  if (platform === 'Android') return { png, area: { x: 0, y: 0, ...size } };
  const win = await d.windowSize();
  return { png, area: { x: 0, y: 0, width: win.width, height: win.height } };
}
