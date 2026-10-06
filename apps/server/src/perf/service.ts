import { newId, VariableResolver } from '@stepforge/core';
import { getSetting, setSetting, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { loadConfigFromParams } from '@stepforge/executor-perf';
import {
  findK6,
  installK6,
  k6Version,
  runK6,
  runLighthouse,
  runLoadTest,
  type LighthouseCategory,
  type LighthouseResult,
  type LoadReport,
  type LoadTick,
} from '@stepforge/perf';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { EventBus } from '../context.ts';

export type LoadAuthorization = { at: string; statement: string };
export const AUTHORIZATION_STATEMENT = 'I own or am authorized to load-test this system.';

type AdHocRun = {
  id: string;
  applicationId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  ticks: LoadTick[];
  report?: LoadReport;
  error?: string;
  abort: AbortController;
  startedAt: string;
};

/** Load tests (designer and steps), Lighthouse on demand, k6 detection and the load-test authorization rule. */
export class PerfService {
  private runs = new Map<string, AdHocRun>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly bus: EventBus,
    private readonly binDir: string,
    private readonly artifactsDir: string,
  ) {}

  // ─── Authorization (Section 12) ────────────────────────────────────────
  authorization(applicationId: string): LoadAuthorization | null {
    return getSetting<LoadAuthorization | null>(this.db, `loadAuthorization:${applicationId}`, null);
  }

  authorize(applicationId: string): LoadAuthorization {
    repo.getApplication(this.db, applicationId);
    const a = { at: new Date().toISOString(), statement: AUTHORIZATION_STATEMENT };
    setSetting(this.db, `loadAuthorization:${applicationId}`, a);
    return a;
  }

  revoke(applicationId: string): void {
    setSetting(this.db, `loadAuthorization:${applicationId}`, null);
  }

  assertAuthorized(applicationId: string): void {
    if (!this.authorization(applicationId))
      throw new Error(
        'Load tests need a confirmation that you own or are authorized to test this system. Confirm it once for this application on the Performance page.',
      );
  }

  // ─── Tools ────────────────────────────────────────────────────────────
  k6Path(): string | null {
    return findK6({
      binDir: this.binDir,
      configuredPath: getSetting<string>(this.db, 'k6Path', '') || undefined,
    });
  }

  k6Status() {
    const path = this.k6Path();
    return { available: !!path, path, version: path ? k6Version(path) : null };
  }

  async installK6() {
    await installK6(this.binDir);
    return this.k6Status();
  }

  chromePath(): string {
    return chromium.executablePath();
  }

  private resolverFor(environmentId: string) {
    const env = repo.getEnvironment(this.db, environmentId);
    return {
      env,
      resolver: new VariableResolver({
        env: { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name },
        secret: repo.resolveSecrets(this.db, this.masterKey, env.id),
        data: {},
        run: { id: 'load-designer' },
        vars: {},
      }),
    };
  }

  // ─── Load Designer runs ────────────────────────────────────────────────
  /**
   * Starts a load test from the Load Designer. `params` has the perf.loadTest shape with `{{…}}` placeholders,
   * resolved here against the environment (secrets never reach the browser).
   */
  startLoad(input: {
    applicationId: string;
    environmentId: string;
    params: Record<string, unknown>;
    confirm?: string;
  }): { id: string } {
    const app = repo.getApplication(this.db, input.applicationId);
    const { env, resolver } = this.resolverFor(input.environmentId);
    if (env.applicationId !== app.id)
      throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
    try {
      this.assertAuthorized(app.id);
    } catch (err) {
      throw new repo.RepoError(403, 'not_authorized', (err as Error).message);
    }
    if (env.isProduction && input.confirm?.trim() !== app.name)
      throw new repo.RepoError(
        403,
        'confirmation_required',
        `This is a production environment. Type the application name ("${app.name}") to start a load test.`,
      );
    let config;
    try {
      config = loadConfigFromParams(resolver.resolve(input.params) as Record<string, unknown>, env.baseUrl);
    } catch (err) {
      throw new repo.RepoError(400, 'invalid', (err as Error).message);
    }
    const engine = input.params.engine === 'k6' ? this.k6Path() : null;
    if (input.params.engine === 'k6' && !engine)
      throw new repo.RepoError(400, 'k6_missing', 'k6 is not installed');
    const id = newId();
    const run: AdHocRun = {
      id,
      applicationId: app.id,
      status: 'running',
      ticks: [],
      abort: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, run);
    // Keep the last 20 designer runs in memory.
    for (const old of [...this.runs.keys()].slice(0, Math.max(0, this.runs.size - 20))) this.runs.delete(old);

    const job = engine
      ? runK6(engine, config, { signal: run.abort.signal })
      : runLoadTest(config, {
          signal: run.abort.signal,
          onTick: (t) => {
            run.ticks.push(t);
            this.bus.publish({ type: 'load.tick', loadId: id, tick: t });
          },
        });
    job
      .then((report) => {
        run.report = report;
        run.status = report.cancelled ? 'cancelled' : 'done';
        const dir = join(this.artifactsDir, 'load');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(report, null, 2));
      })
      .catch((err: Error) => {
        run.status = 'failed';
        run.error = err.message;
      })
      .finally(() => this.bus.publish({ type: 'load.finished', loadId: id, status: run.status }));
    return { id };
  }

  getLoad(id: string) {
    const r = this.runs.get(id);
    if (!r) throw repo.notFound('Load test', id);
    return {
      id: r.id,
      applicationId: r.applicationId,
      status: r.status,
      ticks: r.ticks,
      report: r.report,
      error: r.error,
      startedAt: r.startedAt,
    };
  }

  cancelLoad(id: string) {
    const r = this.runs.get(id);
    if (!r) throw repo.notFound('Load test', id);
    r.abort.abort();
    return this.getLoad(id);
  }

  async idle(): Promise<void> {
    while ([...this.runs.values()].some((r) => r.status === 'running'))
      await new Promise((res) => setTimeout(res, 50));
  }

  // ─── Lighthouse on demand ─────────────────────────────────────────────
  async lighthouse(input: {
    environmentId: string;
    url: string;
    categories?: LighthouseCategory[];
    formFactor?: 'desktop' | 'mobile';
  }): Promise<LighthouseResult & { reportFile?: string }> {
    const { env } = this.resolverFor(input.environmentId);
    const url = new URL(input.url || '/', env.baseUrl).toString();
    const name = `lh-${newId()}`;
    try {
      const r = await runLighthouse({
        url,
        chromePath: this.chromePath(),
        categories: input.categories,
        formFactor: input.formFactor,
        outputDir: join(this.artifactsDir, 'lighthouse'),
        reportName: name,
      });
      return {
        ...r,
        reportPath: undefined,
        reportFile: r.reportPath ? `lighthouse/${name}.html` : undefined,
      };
    } catch (err) {
      throw new repo.RepoError(502, 'lighthouse_failed', (err as Error).message);
    }
  }
}
