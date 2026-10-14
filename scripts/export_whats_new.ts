/// <reference lib="dom" />
/**
 * Renders the "what's new" post images (StepForge by Md Zarin Tasnim) from docs/case-study/whats-new.html into
 * docs/case-study/whats-new/01-….png … 15-….png, 1200×675 each (LinkedIn and X), and checks that no text leaves its
 * card or runs under the screenshot.
 *
 *   npx tsx scripts/export_whats_new.ts
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'docs/case-study');
const OUT = join(DIR, 'whats-new');
const NAMES = [
  '01-whats-new',
  '02-manual-testing',
  '03-screenshots-bugs',
  '04-visual-checkpoints',
  '05-any-web-app',
  '06-campaigns',
  '07-reusable-blocks',
  '08-before-after-hooks',
  '09-element-repository',
  '10-test-data-library',
  '11-page-conditions',
  '12-soap-kafka-ftp',
  '13-slack-teams',
  '14-network-queue',
  '15-free-open-source',
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Old images only: the post text (POST.md) lives in the same folder.
  for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));
  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 720 }, deviceScaleFactor: 1 });
    await page.addInitScript('globalThis.__name = (f) => f');
    await page.goto(`${pathToFileURL(join(DIR, 'whats-new.html')).href}?export`);
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (!(await page.evaluate(() => document.fonts.check('700 40px Inter'))))
      throw new Error('the Inter font did not load');
    const broken = await page.$$eval('img', (imgs) =>
      imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
    );
    if (broken.length) throw new Error(`images missing: ${broken.join(', ')}`);
    const ids = await page.$$eval('.card', (els) => els.map((e) => e.id));
    if (ids.length !== NAMES.length) throw new Error(`Expected ${NAMES.length} cards, found ${ids.length}`);
    for (const [i, id] of ids.entries()) {
      // Text must stay inside the card and must not run under the screenshot.
      const issues = await page.$eval(`#${id}`, (card) => {
        const out: string[] = [];
        const box = card.getBoundingClientRect();
        const shot = card.querySelector('.browser')?.getBoundingClientRect();
        for (const el of card.querySelectorAll('.safe *')) {
          if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const label = `"${(el.textContent ?? '').trim().slice(0, 30)}"`;
          if (r.left < box.left || r.top < box.top || r.right > box.right || r.bottom > box.bottom)
            out.push(`${label} is outside the card`);
          if (shot && r.right > shot.left - 16 && r.bottom > shot.top && r.top < shot.bottom)
            out.push(`${label} runs under the screenshot`);
        }
        const safe = card.querySelector('.safe')!;
        if (safe.scrollHeight > safe.clientHeight + 1) out.push('text taller than the card');
        return out;
      });
      problems.push(...issues.map((x) => `${NAMES[i]}: ${x}`));
      const file = join(OUT, `${NAMES[i]}.png`);
      await page.locator(`#${id}`).screenshot({ path: file });
      const b = readFileSync(file);
      const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
      if (w !== 1200 || h !== 675) problems.push(`${NAMES[i]} is ${w}×${h}`);
      console.log(`  ✓ ${relative(ROOT, file)}  ${w}×${h}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
    }
  } finally {
    await browser.close();
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('\nAll cards 1200×675; no text outside its card or under a screenshot.');
}

void main();
