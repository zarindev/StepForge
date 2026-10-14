import { VIEWPORT_PRESETS } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { newId } from '@stepforge/core';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { EventBus } from '../context.ts';
import type { RunManager } from './manager.ts';
import type { ManualRunService } from './manual.ts';

const TOOLBAR = readFileSync(new URL('./manual-toolbar.js', import.meta.url), 'utf8');

type Clip = { startMs: number; endMs: number; video?: string };
type Result = {
  number: string;
  status: string;
  note: string;
  screenshots: string[];
  clips: Clip[];
};
type Session = {
  runId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** The recording starts with the browser context; clips are offsets into it. */
  startedAt: number;
  video?: string;
  /** The step the tester chose with "go" (and its status then); cleared once that step gets a (new) result. */
  current: { number: string; status: string } | null;
  clipStart: number | null;
  closing?: Promise<void>;
};

/**
 * The browser a tester uses for a manual test: it opens the application with a StepForge panel on top (current step,
 * what to expect, the next step; pass / fail / blocked / skip; screenshots; screen-recording clips). The whole session
 * is recorded as a video, and every action is saved to the test's results at once, so the dashboard follows along.
 */
export class ManualBrowserService {
  private sessions = new Map<string, Session>();
  /** Browsers being launched: a second "open" while one starts gets the same one. */
  private opening = new Map<string, Promise<{ open: true; url: string }>>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly bus: EventBus,
    private readonly runs: RunManager,
    private readonly manual: ManualRunService,
    private readonly artifactsRoot: string,
    private readonly headless = process.env.STEPFORGE_MANUAL_HEADLESS === '1',
  ) {
    // A finished or cancelled run closes its browsers.
    bus.on('event', (e: { type: string; run?: { id: string; status: string } }) => {
      if (e.type !== 'run.updated' || !e.run || e.run.status === 'running' || e.run.status === 'queued')
        return;
      for (const [itemId, s] of this.sessions) if (s.runId === e.run.id) void this.close(itemId);
    });
    // A result changed (here or in the dashboard): the panel shows it.
    bus.on('event', (e: { type: string; itemId?: string }) => {
      if (e.type === 'manual.updated' && e.itemId) void this.refresh(e.itemId);
      // A test finished (here or in the dashboard) closes its browser.
      if (e.type === 'manual.finished' && e.itemId) void this.close(e.itemId);
    });
  }

  private rel(abs: string) {
    return relative(this.artifactsRoot, abs).split(sep).join('/');
  }

  isOpen(itemId: string) {
    return this.sessions.has(itemId);
  }

  /** For tests: the page the tester sees. */
  pageOf(itemId: string): Page | undefined {
    return this.sessions.get(itemId)?.page;
  }

  /** Opens (or brings forward) the browser for one test of a manual run. */
  open(itemId: string): Promise<{ open: true; url: string }> {
    const existing = this.sessions.get(itemId);
    if (existing)
      return existing.page
        .bringToFront()
        .catch(() => {})
        .then(() => ({ open: true as const, url: existing.page.url() }));
    let opening = this.opening.get(itemId);
    if (!opening) {
      // Stored before anything is awaited, so concurrent calls share one browser.
      opening = this.launch(itemId).finally(() => this.opening.delete(itemId));
      this.opening.set(itemId, opening);
    }
    return opening;
  }

  private async launch(itemId: string): Promise<{ open: true; url: string }> {
    const check = this.manual.checklist(itemId);
    if (check.run.status !== 'running')
      throw new repo.RepoError(409, 'conflict', `This run is ${check.run.status}`);
    if (!['queued', 'running'].includes(check.item.status))
      throw new repo.RepoError(409, 'conflict', 'This test is finished');
    const run = this.runs.getRun(check.run.id);
    const env = run.environmentId ? repo.getEnvironment(this.db, run.environmentId) : undefined;
    const viewport =
      VIEWPORT_PRESETS[(run.viewport as keyof typeof VIEWPORT_PRESETS) ?? 'desktop'] ??
      VIEWPORT_PRESETS.desktop;
    const videoDir = join(this.artifactsRoot, 'runs', run.id, itemId, 'manual-video');
    mkdirSync(videoDir, { recursive: true });

    const browser = await chromium.launch({ headless: this.headless });
    let session: Session | undefined;
    try {
      const context = await browser.newContext({
        viewport,
        ignoreHTTPSErrors: true,
        ...(env && { baseURL: env.baseUrl }),
        recordVideo: { dir: videoDir, size: viewport },
      });
      // Actions from this browser only ever touch this session.
      await context.exposeBinding('__sfManual', (_src, action: Record<string, unknown>) =>
        session && this.sessions.get(itemId) === session ? this.handle(itemId, action) : null,
      );
      await context.addInitScript({ content: TOOLBAR });
      const page = await context.newPage();
      session = {
        runId: run.id,
        browser,
        context,
        page,
        startedAt: Date.now(),
        current: null,
        clipStart: null,
      };
      session.video = await page
        .video()
        ?.path()
        .then((p) => this.rel(p))
        .catch(() => undefined);
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
    const s = session;
    this.sessions.set(itemId, s);
    // The tester closing the window ends the session (the video is kept).
    browser.on('disconnected', () => void this.end(itemId, s));
    s.page.on('close', () => void this.end(itemId, s));
    // The run may have finished (or the test been finished) while the browser started.
    const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    const runStatus = this.runs.getRun(run.id).status;
    if (runStatus !== 'running' || (item && !['queued', 'running'].includes(item.status))) {
      await this.end(itemId, s);
      throw new repo.RepoError(
        409,
        'conflict',
        runStatus !== 'running' ? `This run is ${runStatus}` : 'This test is finished',
      );
    }

    const url = this.startUrl(itemId, env?.baseUrl);
    await s.page.goto(url).catch(() => {});
    this.bus.publish({ type: 'manual.browser', runId: run.id, itemId, open: true });
    return { open: true, url };
  }

  /** The scenario's first "open page" step, else the environment's base URL. */
  private startUrl(itemId: string, baseUrl = 'about:blank'): string {
    const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    let steps: { type: string; params?: unknown; enabled?: boolean }[] = [];
    try {
      steps = item?.scenarioId ? repo.getScenario(this.db, item.scenarioId).steps : [];
    } catch {
      // The scenario was deleted: start at the base URL.
    }
    const first = steps.find((s) => s.type === 'ui.navigate' && s.enabled !== false);
    const raw = String((first?.params as { url?: unknown } | undefined)?.url ?? '').replace(
      /\{\{\s*env\.baseUrl\s*\}\}/g,
      baseUrl,
    );
    if (!raw || raw.includes('{{')) return baseUrl;
    return /^https?:\/\//.test(raw) ? raw : `${baseUrl.replace(/\/$/, '')}/${raw.replace(/^\//, '')}`;
  }

  /** The panel's view of the test: lines with their status, the current step, whether a clip is recording. */
  private state(itemId: string) {
    const s = this.sessions.get(itemId);
    const check = this.manual.checklist(itemId);
    const results = new Map(check.results.map((r) => [r.number, r]));
    const steps = check.lines.filter((l) => !l.group);
    // The step chosen with "go" stays current until it gets a (new) result; otherwise the first step without one.
    const statusOf = (n: string) => results.get(n)?.status ?? 'pending';
    if (
      s?.current &&
      (!steps.some((l) => l.number === s.current!.number) || statusOf(s.current.number) !== s.current.status)
    )
      s.current = null;
    const current = s?.current?.number ?? steps.find((l) => statusOf(l.number) === 'pending')?.number ?? null;
    return {
      title: check.item.labelJson?.scenario ?? 'Manual test',
      current,
      recording: s?.clipStart !== null && s?.clipStart !== undefined,
      lines: check.lines.map((l) => ({
        number: l.number,
        text: l.text,
        group: l.group,
        status: results.get(l.number)?.status ?? 'pending',
        screenshots: results.get(l.number)?.screenshots.length ?? 0,
      })),
    };
  }

  /** Saves one line (only that line: what the dashboard saved for other lines is kept). */
  private save(itemId: string, change: (r: Result) => void, number: string) {
    const stored = this.manual.checklist(itemId).results.find((x) => x.number === number);
    const r: Result = stored
      ? {
          number,
          status: stored.status,
          note: stored.note,
          screenshots: [...stored.screenshots],
          clips: [...stored.clips],
        }
      : { number, status: 'pending', note: '', screenshots: [], clips: [] };
    change(r);
    this.manual.save(itemId, { result: r });
  }

  /** The panel cannot change a finished test (finishing it closes this browser). */
  private assertOpen(itemId: string) {
    const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    if (item && !['queued', 'running'].includes(item.status)) throw new Error('This test is finished');
  }

  /** Pushes the latest state to the panel (after a change made in the dashboard, too). */
  async refresh(itemId: string) {
    const s = this.sessions.get(itemId);
    if (!s) return;
    await s.page
      .evaluate(
        (st) => (window as unknown as { __sfManualRender?: (x: unknown) => void }).__sfManualRender?.(st),
        this.state(itemId),
      )
      .catch(() => {});
  }

  private async handle(itemId: string, a: Record<string, unknown>) {
    const s = this.sessions.get(itemId);
    if (!s) return null;
    const number = typeof a.number === 'string' ? a.number : '';
    const note = typeof a.note === 'string' ? a.note.trim() : '';
    if (['mark', 'screenshot', 'clipStop', 'finish'].includes(String(a.type))) this.assertOpen(itemId);
    // The same note is not added twice (e.g. saved with a screenshot, then sent again with the result).
    const addNote = (r: Result) => {
      if (note && !r.note.split('\n').includes(note)) r.note = r.note ? `${r.note}\n${note}` : note;
    };
    switch (a.type) {
      case 'mark': {
        const status = String(a.status);
        if (!['passed', 'failed', 'blocked', 'skipped'].includes(status)) break;
        this.save(
          itemId,
          (r) => {
            r.status = status;
            addNote(r);
          },
          number,
        );
        // The chosen step has its result: move on to the next step without one.
        if (s.current?.number === number) s.current = null;
        break;
      }
      case 'screenshot': {
        const shot = await this.screenshot(itemId, number);
        this.save(
          itemId,
          (r) => {
            r.screenshots.push(shot);
            addNote(r);
          },
          number,
        );
        break;
      }
      case 'clipStart':
        s.clipStart = Date.now() - s.startedAt;
        break;
      case 'clipStop':
        if (s.clipStart !== null) {
          const clip: Clip = {
            startMs: s.clipStart,
            endMs: Date.now() - s.startedAt,
            ...(s.video && { video: s.video }),
          };
          s.clipStart = null;
          this.save(itemId, (r) => r.clips.push(clip), number);
        }
        break;
      case 'go': {
        const r = this.manual.checklist(itemId).results.find((x) => x.number === number);
        s.current = number ? { number, status: r?.status ?? 'pending' } : null;
        break;
      }
      case 'finish': {
        // Finishing closes this browser (see the 'manual.finished' event).
        this.manual.save(itemId, { done: true });
        return { ...this.state(itemId), current: null };
      }
    }
    return this.state(itemId);
  }

  /** A screenshot of the page without the StepForge panel, kept with the test. */
  private async screenshot(itemId: string, number: string): Promise<string> {
    const s = this.sessions.get(itemId)!;
    const rel = `runs/${s.runId}/${itemId}/manual-${number.replace(/[^\w.-]+/g, '_')}-${Date.now()}.png`;
    mkdirSync(join(this.artifactsRoot, 'runs', s.runId, itemId), { recursive: true });
    const hide = (h: boolean) =>
      s.page.evaluate(
        (x) => (window as unknown as { __sfManualHide?: (v: boolean) => void }).__sfManualHide?.(x),
        h,
      );
    await hide(true).catch(() => {});
    try {
      await s.page.screenshot({ path: join(this.artifactsRoot, rel) });
    } finally {
      await hide(false).catch(() => {});
    }
    return rel;
  }

  /** Closes the browser; its recording becomes the test's video evidence. Never throws. */
  close(itemId: string): Promise<void> {
    const s = this.sessions.get(itemId);
    return s ? this.end(itemId, s) : Promise.resolve();
  }

  /** Ends one session; events from a session that is no longer the item's current one are ignored. */
  private end(itemId: string, s: Session): Promise<void> {
    if (this.sessions.get(itemId) !== s) return s.closing ?? Promise.resolve();
    s.closing ??= (async () => {
      this.sessions.delete(itemId);
      await s.context.close().catch(() => {});
      await s.browser.close().catch(() => {});
      try {
        if (s.video && existsSync(join(this.artifactsRoot, s.video))) {
          this.db
            .insert(schema.artifacts)
            .values({
              id: newId(),
              runItemId: itemId,
              kind: 'video',
              path: s.video,
              size: statSync(join(this.artifactsRoot, s.video)).size,
            })
            .run();
        }
        this.bus.publish({ type: 'manual.browser', runId: s.runId, itemId, open: false });
        this.bus.publish({ type: 'manual.updated', runId: s.runId, itemId });
      } catch {
        // Keeping the video is best effort: closing must never fail (it is often not awaited).
      }
    })();
    return s.closing;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
