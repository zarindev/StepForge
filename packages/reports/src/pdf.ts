import { chromium, type Browser } from 'playwright';
import { CREDIT, DEFAULT_BRANDING, type Branding } from './types.ts';

let shared: Promise<Browser> | null = null;
const browser = () => {
  shared ??= chromium.launch().catch((err: Error) => {
    shared = null;
    throw err;
  });
  return shared;
};

/** Closes the browser used for PDFs (on shutdown). */
export async function closePdfBrowser(): Promise<void> {
  const b = shared;
  shared = null;
  if (b) await (await b.catch(() => null))?.close();
}

/**
 * Prints HTML to an A4 PDF with Playwright's Chromium (free, offline). Every page carries the author and
 * StepForge credit in its footer, with page numbers.
 */
export async function htmlToPdf(html: string, b: Branding = DEFAULT_BRANDING): Promise<Buffer> {
  const ctx = await (await browser()).newContext();
  try {
    const page = await ctx.newPage();
    // Reports are self-contained: block any network access while rendering.
    await page.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    await page.setContent(html, { waitUntil: 'load' });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;color:#64748b;width:100%;padding:0 12mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Prepared by ${esc(b.author)} · ${esc(CREDIT)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await ctx.close();
  }
}
