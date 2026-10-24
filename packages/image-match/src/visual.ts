import type { VisualResult } from '@stepforge/core';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** A file-name-safe baseline key: per step (chain), browser and screen size, or a name the step gives. */
export function baselineKey(parts: {
  name?: string;
  stepId: string;
  browser: string;
  width: number;
  height: number;
}) {
  const id = parts.name?.trim() || parts.stepId;
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Long keys keep a readable start plus a hash of the whole id, so ids sharing a long prefix never collide.
  const base =
    safe.length > 80
      ? `${safe.slice(0, 60)}_${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
      : safe;
  return `${base}-${parts.browser}-${parts.width}x${parts.height}.png`;
}

/**
 * Compares a screenshot with its approved baseline. The first time there is no baseline: the screenshot becomes it
 * ("new", passes). Otherwise pixels are compared (`threshold` = per-pixel colour tolerance, 0–1) and the step passes
 * when at most `maxDiffPercent` of the pixels differ; a difference image marks them in red.
 */
export function compareWithBaseline(input: {
  actual: string;
  baseline: string;
  diff: string;
  key: string;
  threshold: number;
  maxDiffPercent: number;
}): VisualResult {
  const { actual, baseline, diff, key, threshold, maxDiffPercent } = input;
  const base: Omit<VisualResult, 'status'> = { key, baseline, actual, maxDiffPercent };
  if (!existsSync(baseline)) {
    mkdirSync(dirname(baseline), { recursive: true });
    copyFileSync(actual, baseline);
    return { ...base, status: 'new' };
  }
  const a = PNG.sync.read(readFileSync(actual));
  const b = PNG.sync.read(readFileSync(baseline));
  if (a.width !== b.width || a.height !== b.height)
    return {
      ...base,
      status: 'sizeChanged',
      size: { width: a.width, height: a.height, baselineWidth: b.width, baselineHeight: b.height },
    };
  const out = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold });
  const diffPercent = Math.round((differing / (a.width * a.height)) * 100 * 1000) / 1000;
  const changed = diffPercent > maxDiffPercent;
  if (differing > 0) writeFileSync(diff, PNG.sync.write(out));
  return {
    ...base,
    ...(differing > 0 && { diff }),
    diffPercent,
    status: changed ? 'changed' : 'match',
    size: { width: a.width, height: a.height },
  };
}

/** A part of a PNG (in its pixels, clipped to the image), as a new PNG. */
export function cropPng(png: Buffer, r: { x: number; y: number; width: number; height: number }): Buffer {
  const img = PNG.sync.read(png);
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const width = Math.min(img.width - x, Math.round(r.width));
  const height = Math.min(img.height - y, Math.round(r.height));
  if (width <= 0 || height <= 0) return png;
  if (x === 0 && y === 0 && width === img.width && height === img.height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, x, y, width, height, 0, 0);
  return PNG.sync.write(out);
}
