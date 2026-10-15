import { PNG } from 'pngjs';

/** A grayscale image (0–255 per pixel). */
export type Gray = { width: number; height: number; data: Float32Array };

export type ImageMatch = {
  /** Whether the best place scores at least the threshold. */
  found: boolean;
  /** The best place (top-left corner and size, in screenshot pixels) and its score (0–1, 1 = identical). */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

/** A PNG (file contents) as grayscale. */
export function decodePng(png: Buffer): Gray {
  const img = PNG.sync.read(png);
  const data = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = img.data[p + 3]! / 255;
    // Transparent pixels count as white (a cropped picture's background).
    data[i] =
      (0.299 * img.data[p]! + 0.587 * img.data[p + 1]! + 0.114 * img.data[p + 2]!) * a + 255 * (1 - a);
  }
  return { width: img.width, height: img.height, data };
}

/** The PNG inside a data URL (`data:image/png;base64,…`), or undefined when it is not one. */
export function pngFromDataUrl(value: string): Buffer | undefined {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  return m ? Buffer.from(m[1]!, 'base64') : undefined;
}

/** Averages f×f blocks: the image at 1/f of its size. */
function shrink(g: Gray, f: number): Gray {
  if (f === 1) return g;
  const width = Math.floor(g.width / f);
  const height = Math.floor(g.height / f);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) {
        const row = (y * f + j) * g.width + x * f;
        for (let i = 0; i < f; i++) sum += g.data[row + i]!;
      }
      data[y * width + x] = sum / (f * f);
    }
  return { width, height, data };
}

/** Running sums of values and of squares, so any rectangle's sum costs four lookups. */
function integrals(g: Gray): { sum: Float64Array; sq: Float64Array } {
  const w = g.width + 1;
  const sum = new Float64Array(w * (g.height + 1));
  const sq = new Float64Array(w * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < g.width; x++) {
      const v = g.data[y * g.width + x]!;
      rs += v;
      rq += v * v;
      sum[(y + 1) * w + x + 1] = sum[y * w + x + 1]! + rs;
      sq[(y + 1) * w + x + 1] = sq[y * w + x + 1]! + rq;
    }
  }
  return { sum, sq };
}

/** The template minus its mean, and the sum of its squares; undefined when it has no detail (one flat colour). */
function prepare(t: Gray): { centred: Float32Array; energy: number } | undefined {
  let mean = 0;
  for (const v of t.data) mean += v;
  mean /= t.data.length;
  const centred = new Float32Array(t.data.length);
  let energy = 0;
  for (let i = 0; i < t.data.length; i++) {
    const c = t.data[i]! - mean;
    centred[i] = c;
    energy += c * c;
  }
  return energy / t.data.length < 1 ? undefined : { centred, energy };
}

/** Normalized cross-correlation of the template at (x, y): 1 = identical, independent of brightness and contrast. */
function score(
  s: Gray,
  ints: { sum: Float64Array; sq: Float64Array },
  t: Gray,
  prep: { centred: Float32Array; energy: number },
  x: number,
  y: number,
): number {
  const w = s.width + 1;
  const n = t.width * t.height;
  const a = y * w + x;
  const b = y * w + x + t.width;
  const c = (y + t.height) * w + x;
  const d = (y + t.height) * w + x + t.width;
  const sum = ints.sum[d]! - ints.sum[b]! - ints.sum[c]! + ints.sum[a]!;
  const sq = ints.sq[d]! - ints.sq[b]! - ints.sq[c]! + ints.sq[a]!;
  const variance = sq - (sum * sum) / n;
  if (variance < n) return 0; // a flat area cannot match a detailed picture
  let num = 0;
  for (let j = 0; j < t.height; j++) {
    const row = (y + j) * s.width + x;
    const trow = j * t.width;
    for (let i = 0; i < t.width; i++) num += s.data[row + i]! * prep.centred[trow + i]!;
  }
  return num / Math.sqrt(prep.energy * variance);
}

/**
 * Finds the template in the screen: a coarse search on shrunken copies, then a precise one around the best
 * candidates. The template must be at the screenshot's scale (crop it from a screenshot of the same device).
 */
export function findImage(
  screenPng: Buffer,
  templatePng: Buffer,
  opts: { threshold?: number } = {},
): ImageMatch {
  const threshold = opts.threshold ?? 0.9;
  const screen = decodePng(screenPng);
  const template = decodePng(templatePng);
  const none = { found: false, x: 0, y: 0, width: template.width, height: template.height, score: 0 };
  if (template.width > screen.width || template.height > screen.height) return none;
  if (!prepare(template)) throw new Error('The picture is a single flat colour: crop one with some detail');

  // Coarse level: the template keeps at least ~8 px on its short side; the work stays in the low millions.
  const short = Math.min(template.width, template.height);
  let f = Math.max(1, Math.floor(short / 10));
  const work = (k: number) =>
    ((screen.width / k) * (screen.height / k) * (template.width / k) * (template.height / k)) / 1e6;
  while (work(f) > 150 && Math.min(template.width, template.height) / (f + 1) >= 5) f++;

  const s1 = shrink(screen, f);
  const t1 = shrink(template, f);
  const p1 = prepare(t1);
  const candidates: { x: number; y: number; score: number }[] = [];
  let coarseBest = { x: 0, y: 0, score: -1 };
  if (p1) {
    const i1 = integrals(s1);
    for (let y = 0; y + t1.height <= s1.height; y++)
      for (let x = 0; x + t1.width <= s1.width; x++) {
        const v = score(s1, i1, t1, p1, x, y);
        if (v > coarseBest.score) coarseBest = { x, y, score: v };
        if (v < threshold - 0.25) continue;
        // Keep the five best, apart from each other.
        const near = candidates.findIndex(
          (c) => Math.abs(c.x - x) <= t1.width / 2 && Math.abs(c.y - y) <= t1.height / 2,
        );
        if (near >= 0) {
          if (candidates[near]!.score < v) candidates[near] = { x, y, score: v };
        } else candidates.push({ x, y, score: v });
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length > 5) candidates.pop();
      }
  }

  // Nothing close: refine the best place anyway, so the result can say how close it came.
  if (!candidates.length && coarseBest.score > -1) candidates.push(coarseBest);

  // Fine level: full resolution around each candidate (or everywhere when the screen is small).
  const p0 = prepare(template)!;
  const i0 = integrals(screen);
  let best = { x: 0, y: 0, score: -1 };
  const search = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y <= Math.min(screen.height - template.height, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(screen.width - template.width, x1); x++) {
        const v = score(screen, i0, template, p0, x, y);
        if (v > best.score) best = { x, y, score: v };
      }
  };
  if (f === 1 && !candidates.length) search(0, 0, screen.width, screen.height);
  for (const c of candidates) search(c.x * f - 2 * f, c.y * f - 2 * f, c.x * f + 2 * f, c.y * f + 2 * f);
  if (best.score < 0) return none;
  return {
    found: best.score >= threshold,
    x: best.x,
    y: best.y,
    width: template.width,
    height: template.height,
    score: Math.round(best.score * 1000) / 1000,
  };
}
