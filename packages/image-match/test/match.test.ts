import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { findImage, pngFromDataUrl } from '../src/index.ts';

/** A noisy "screen" with a few shapes, as a PNG. */
function screen(width: number, height: number, seed = 1): PNG {
  const png = new PNG({ width, height });
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 255;
  for (let i = 0; i < width * height; i++) {
    const v = 200 + (rand() - 128) / 10;
    png.data.set([v, v, v, 255], i * 4);
  }
  // Some buttons: filled rectangles with a darker border and "text" stripes.
  for (const [bx, by, bw, bh, c] of [
    [40, 60, 160, 48, 60],
    [300, 400, 120, 40, 120],
    [500, 900, 200, 60, 30],
  ] as const) {
    if (bx + bw > width || by + bh > height) continue;
    for (let y = by; y < by + bh; y++)
      for (let x = bx; x < bx + bw; x++) {
        const edge = x < bx + 2 || y < by + 2 || x >= bx + bw - 2 || y >= by + bh - 2;
        const stripe = (x - bx) % 9 < 3 && y > by + bh / 3 && y < by + (2 * bh) / 3;
        const v = edge ? 20 : stripe ? 250 : c;
        png.data.set([v, v * 0.8, v * 0.6, 255], (y * width + x) * 4);
      }
  }
  return png;
}

function crop(src: PNG, x: number, y: number, w: number, h: number): Buffer {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out);
}

describe('finding a picture in a screenshot', () => {
  const s = screen(1080, 1600);
  const shot = PNG.sync.write(s);

  it('finds a cropped button exactly, with a score near 1', () => {
    const m = findImage(shot, crop(s, 300, 400, 120, 40));
    expect(m).toMatchObject({ found: true, x: 300, y: 400, width: 120, height: 40 });
    expect(m.score).toBeGreaterThan(0.99);
  });

  it('still finds it when the whole screen is darker (brightness does not matter)', () => {
    const dark = PNG.sync.read(shot);
    for (let i = 0; i < dark.data.length; i += 4)
      for (let c = 0; c < 3; c++) dark.data[i + c] = dark.data[i + c]! * 0.6;
    const m = findImage(PNG.sync.write(dark), crop(s, 500, 900, 200, 60));
    expect(m).toMatchObject({ found: true, x: 500, y: 900 });
  });

  it('a picture that is not on the screen is not found, and says how close it came', () => {
    const other = screen(400, 300, 7);
    // A different button pattern: a checkerboard.
    for (let y = 100; y < 160; y++)
      for (let x = 100; x < 220; x++) {
        const v = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? 0 : 255;
        other.data.set([v, 0, 255 - v, 255], (y * 400 + x) * 4);
      }
    const m = findImage(shot, crop(other, 100, 100, 120, 60));
    expect(m.found).toBe(false);
    expect(m.score).toBeLessThan(0.9);
    expect(m.score).toBeGreaterThanOrEqual(0);
  });

  it('small pictures work too, and a flat colour is refused', () => {
    expect(findImage(shot, crop(s, 40, 60, 24, 24))).toMatchObject({ found: true, x: 40, y: 60 });
    const flat = new PNG({ width: 20, height: 20 });
    flat.data.fill(128);
    expect(() => findImage(shot, PNG.sync.write(flat))).toThrow(/single flat colour/);
  });

  it('reads PNG data URLs', () => {
    const png = crop(s, 40, 60, 24, 24);
    expect(pngFromDataUrl(`data:image/png;base64,${png.toString('base64')}`)).toEqual(png);
    expect(pngFromDataUrl('/some/file.png')).toBeUndefined();
  });

  it('is quick enough for a phone screenshot', () => {
    const big = screen(1170, 2532, 3);
    const t0 = Date.now();
    findImage(PNG.sync.write(big), crop(big, 500, 900, 200, 60));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
