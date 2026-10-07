/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Exports the StepForge case study (StepForge by Md Zarin Tasnim) from docs/case-study/case-study.html and promo.html
 * into docs/case-study/export/:
 *
 *   StepForge-Case-Study.pdf            15 pages, 1600×1200
 *   slides/slide-01.png … slide-15.png  1600×1200
 *   upwork/00-thumbnail.png             1600×1200 (content inside a 90% safe area)
 *   upwork/01-hybrid-flow.png … 06-export.png
 *   upwork/jpg/*.jpg                    the same images as JPEG, each under 2 MB
 *   social/github-social-preview.png    1280×640
 *   social/linkedin-x-post.png          1200×675
 *
 * First it writes the numbers from docs/benchmarks.json into every data-bench element of both pages (they are the only
 * numbers allowed), then checks each slide for overflow, and afterwards verifies every file's dimensions and size.
 *
 *   npx tsx scripts/export_case_study.ts            (after scripts/capture_showcase.ts and scripts/benchmark.ts)
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'docs/case-study');
const OUT = join(DIR, 'export');
const SLIDES = 15;
const MAX_JPG = 2 * 1024 * 1024;
const UPWORK: [string, string][] = [
  ['01-hybrid-flow', 's05'],
  ['02-recorder', 's04'],
  ['03-api-sql', 's06'],
  ['04-diagnosis', 's09'],
  ['05-analytics', 's10'],
  ['06-export', 's11'],
];

// ─── Numbers from docs/benchmarks.json ─────────────────────────────────────
type Bench = {
  machine: { cpu: string };
  totals: Record<string, unknown> & { layers: string[] };
  apps: Record<string, unknown>[];
  bugs: { layer: string; detected: boolean }[];
};
const LAYER_NAMES: Record<string, string> = {
  api: 'API',
  db: 'database',
  ui: 'UI',
  email: 'email',
  logic: 'business logic',
  performance: 'performance',
};
function benchValue(b: Bench, key: string): string {
  if (key === 'layersText') {
    const names = b.totals.layers.map((l) => LAYER_NAMES[l] ?? l);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  }
  if (key.startsWith('layer.')) {
    const own = b.bugs.filter((x) => x.layer === key.slice(6));
    if (!own.length) throw new Error(`benchmarks.json has no bugs in layer ${key.slice(6)}`);
    return `${own.filter((x) => x.detected).length}/${own.length}`;
  }
  if (key === 'machineText') return `${/^[aeiou]/i.test(b.machine.cpu) ? 'an' : 'a'} ${b.machine.cpu}`;
  const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], b);
  if (value === undefined || value === null || typeof value === 'object')
    throw new Error(`benchmarks.json has no number for data-bench="${key}"`);
  return String(value);
}
/** Rewrites the text of every data-bench element; returns how many were filled. */
function syncNumbers(file: string, b: Bench): number {
  let n = 0;
  const src = readFileSync(file, 'utf8');
  const out = src.replace(
    /(data-bench="([^"]+)"[^>]*>)([^<]*)(<)/g,
    (_m, open: string, key: string, _old, close) => {
      n++;
      return `${open}${benchValue(b, key)}${close}`;
    },
  );
  if (out !== src) writeFileSync(file, out);
  return n;
}

// ─── Image checks (no image library needed) ────────────────────────────────
function imageSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // JPEG: find the start-of-frame marker
  for (let i = 2; i < b.length;) {
    if (b[i] !== 0xff) throw new Error(`${file}: not a JPEG`);
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error(`${file}: no image size found`);
}

/** Layout problems inside one element: anything poking outside it, or (optionally) into the footer or safe area. */
async function layoutProblems(page: Page, selector: string): Promise<string[]> {
  return page.$eval(selector, (root) => {
    const problems: string[] = [];
    const box = root.getBoundingClientRect();
    if (Math.round(box.width) !== root.clientWidth || root.scrollHeight > root.clientHeight + 1)
      problems.push(`content taller than the slide (${root.scrollHeight}px)`);
    const foot = root.querySelector('.foot')?.getBoundingClientRect();
    const safe = root.querySelector('[data-safe]')?.getBoundingClientRect();
    const name = (el: Element) =>
      `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}> "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('[data-bleed]')) continue;
      if (
        r.left < box.left - 1 ||
        r.top < box.top - 1 ||
        r.right > box.right + 1 ||
        r.bottom > box.bottom + 1
      )
        problems.push(`${name(el)} is outside the frame`);
      if (foot && !el.closest('.foot') && r.bottom > foot.top - 12 && r.top < foot.bottom)
        problems.push(`${name(el)} runs into the footer`);
      if (
        safe &&
        el.closest('[data-safe]') &&
        (r.left < safe.left - 1 || r.right > safe.right + 1 || r.bottom > safe.bottom + 1)
      )
        problems.push(`${name(el)} is outside the 90% safe area`);
      // Text cut off inside its own box
      const cs = getComputedStyle(el);
      if (
        cs.overflow === 'hidden' &&
        el.tagName.toLowerCase() !== 'section' &&
        !el.classList.contains('browser')
      ) {
        if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis')
          problems.push(`${name(el)} cuts off its text`);
      }
    }
    // Text on a social card must not run under its screenshot.
    const shot = root.parentElement?.querySelector(':scope > [data-shot]')?.getBoundingClientRect();
    if (shot)
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (
          r.width &&
          r.right > shot.left &&
          r.left < shot.right &&
          r.bottom > shot.top &&
          r.top < shot.bottom
        )
          problems.push(`${name(el)} overlaps the screenshot`);
      }
    for (const img of root.querySelectorAll('img'))
      if (!(img as HTMLImageElement).complete || !(img as HTMLImageElement).naturalWidth)
        problems.push(`image ${img.getAttribute('src')} did not load`);
    return problems;
  });
}

async function open(page: Page, file: string) {
  await page.goto(`${pathToFileURL(join(DIR, file)).href}?export`);
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const fonts = await page.evaluate(() => document.fonts.check('700 40px Inter'));
  if (!fonts) throw new Error(`${file}: the Inter font did not load`);
}

async function main() {
  const bench = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks.json'), 'utf8')) as Bench;
  const filled =
    syncNumbers(join(DIR, 'case-study.html'), bench) + syncNumbers(join(DIR, 'promo.html'), bench);
  console.log(`Filled ${filled} numbers from docs/benchmarks.json`);

  rmSync(OUT, { recursive: true, force: true });
  for (const d of ['slides', 'upwork/jpg', 'social']) mkdirSync(join(OUT, d), { recursive: true });

  const browser = await chromium.launch();
  const problems: string[] = [];
  const written: { file: string; width: number; height: number; maxBytes?: number }[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    // tsx keeps function names with a __name() helper that the page doesn't have.
    await page.addInitScript('globalThis.__name = (f) => f');

    // ─── Slides ────────────────────────────────────────────────────────────
    await open(page, 'case-study.html');
    const ids = await page.$$eval('.slide', (els) => els.map((e) => e.id));
    if (ids.length !== SLIDES) throw new Error(`Expected ${SLIDES} slides, found ${ids.length}`);
    for (const [i, id] of ids.entries()) {
      for (const p of await layoutProblems(page, `#${id}`)) problems.push(`slide ${i + 1}: ${p}`);
      const file = join(OUT, 'slides', `slide-${String(i + 1).padStart(2, '0')}.png`);
      await page.locator(`#${id}`).screenshot({ path: file });
      written.push({ file, width: 1600, height: 1200 });
    }
    const pdf = join(OUT, 'StepForge-Case-Study.pdf');
    await page.pdf({
      path: pdf,
      width: '1600px',
      height: '1200px',
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pages = (readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pages !== SLIDES) problems.push(`the PDF has ${pages} pages, expected ${SLIDES}`);

    // ─── Upwork images ─────────────────────────────────────────────────────
    const jpg = async (selector: string, name: string, width: number, height: number) => {
      const file = join(OUT, 'upwork/jpg', `${name}.jpg`);
      await page.locator(selector).screenshot({ path: file, type: 'jpeg', quality: 90 });
      written.push({ file, width, height, maxBytes: MAX_JPG });
    };
    for (const [name, id] of UPWORK) {
      const file = join(OUT, 'upwork', `${name}.png`);
      await page.locator(`#${id}`).screenshot({ path: file });
      written.push({ file, width: 1600, height: 1200 });
      await jpg(`#${id}`, name, 1600, 1200);
    }

    // ─── Thumbnail and social cards ────────────────────────────────────────
    await open(page, 'promo.html');
    for (const p of await layoutProblems(page, '#thumbnail')) problems.push(`thumbnail: ${p}`);
    for (const [id, file, w, h] of [
      ['thumbnail', 'upwork/00-thumbnail.png', 1600, 1200],
      ['github', 'social/github-social-preview.png', 1280, 640],
      ['post', 'social/linkedin-x-post.png', 1200, 675],
    ] as const) {
      if (id !== 'thumbnail')
        for (const p of await layoutProblems(page, `#${id} .safe`)) problems.push(`${id}: ${p}`);
      await page.locator(`#${id}`).screenshot({ path: join(OUT, file) });
      written.push({ file: join(OUT, file), width: w, height: h });
    }
    await jpg('#thumbnail', '00-thumbnail', 1600, 1200);
  } finally {
    await browser.close();
  }

  // ─── Verify every file ───────────────────────────────────────────────────
  for (const w of written) {
    const { width, height } = imageSize(w.file);
    const bytes = statSync(w.file).size;
    const rel = relative(ROOT, w.file);
    if (width !== w.width || height !== w.height)
      problems.push(`${rel} is ${width}×${height}, expected ${w.width}×${w.height}`);
    if (w.maxBytes && bytes >= w.maxBytes)
      problems.push(`${rel} is ${(bytes / 2 ** 20).toFixed(2)} MB (limit 2 MB)`);
    console.log(`  ✓ ${rel}  ${width}×${height}  ${(bytes / 1024).toFixed(0)} KB`);
  }
  console.log(
    `  ✓ docs/case-study/export/StepForge-Case-Study.pdf  ${(statSync(join(OUT, 'StepForge-Case-Study.pdf')).size / 1024).toFixed(0)} KB`,
  );
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else
    console.log('\nAll sizes and dimensions verified; no overflow found. Check the slide PNGs by eye too.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
