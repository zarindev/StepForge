import type { VisualResult } from '@stepforge/core';
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
  const base = (parts.name?.trim() || parts.stepId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
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

/** Turns a URL pattern into a test: a glob with `*` (within a path segment) / `**` (anything), else a substring. */
export function urlMatcher(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (p.includes('*')) {
    const esc = (x: string) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `^${p
        .split('**')
        .map((part) => part.split('*').map(esc).join('[^/]*'))
        .join('.*')}$`,
    );
    return (u) => re.test(u);
  }
  return (u) => u.includes(p);
}
