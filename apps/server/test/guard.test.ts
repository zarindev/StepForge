import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test', '__snapshots__'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|yaml|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe('the planted-bug manifest stays secret from StepForge', () => {
  it('no StepForge source file mentions demo/manifests/planted_bugs.json', () => {
    // Only scripts/benchmark.ts (scoring, after the runs) and the demo apps' own comments may refer to it.
    const files = [...sources(join(ROOT, 'apps')), ...sources(join(ROOT, 'packages'))];
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes('planted_bugs'))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
