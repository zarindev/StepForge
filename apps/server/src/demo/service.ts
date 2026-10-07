import { DEFAULT_GATE, saveGate } from '@stepforge/analytics';
import { getSetting, setSetting, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { REPO_ROOT, type ServerConfig } from '../config.ts';
import type { EventBus } from '../context.ts';
import type { EmailService } from '../email/service.ts';

/**
 * The demo workspace (first-run onboarding, `npm start -- --demo`). Sample data only on an explicit request: starts
 * the two demo apps (CareClinic and ShopDesk), imports their scenarios and adds what an export never carries — the
 * demo credentials (public demo data, stored encrypted like any secret), a SQLite connection and a quality gate.
 */
type DemoApp = {
  key: 'clinic' | 'shop';
  name: string;
  slug: string;
  main: string;
  workspace: string;
  port: number;
  env: (port: number, dbFile: string, config: ServerConfig) => Record<string, string>;
  /** The demo app's documented demo accounts (shown on its login page). */
  secrets: Record<string, string>;
  connection: string;
};

export const DEMO_APPS: DemoApp[] = [
  {
    key: 'clinic',
    name: 'CareClinic',
    slug: 'careclinic',
    main: join(REPO_ROOT, 'demo/clinic-app/src/main.ts'),
    workspace: join(REPO_ROOT, 'demo/clinic-app/stepforge/workspace.json'),
    port: 8101,
    env: (port, dbFile, config) => ({
      CLINIC_PORT: String(port),
      CLINIC_DB: dbFile,
      CLINIC_SMTP_PORT: String(config.mailpit.smtpPort),
    }),
    secrets: { password: 'Reception123!', adminPassword: 'Admin123!' },
    connection: 'clinic',
  },
  {
    key: 'shop',
    name: 'ShopDesk',
    slug: 'shopdesk',
    main: join(REPO_ROOT, 'demo/shop-app/src/main.ts'),
    workspace: join(REPO_ROOT, 'demo/shop-app/stepforge/workspace.json'),
    port: 8102,
    env: (port, dbFile) => ({ SHOP_PORT: String(port), SHOP_DB: dbFile }),
    secrets: { adminPassword: 'Admin123!', cashierPassword: 'Cashier123!' },
    connection: 'shop',
  },
];
/** Kept for the first demo workspace format (CareClinic only). */
export const DEMO_WORKSPACE = DEMO_APPS[0]!.workspace;

export type DemoStatus = {
  available: boolean;
  loaded: boolean;
  /** CareClinic's application (the first demo app). */
  applicationId: string | null;
  apps: { key: string; name: string; applicationId: string | null; running: boolean; url: string | null }[];
  clinic: { running: boolean; url: string | null };
};

export type DemoLoaded = {
  applicationId: string;
  clinicUrl: string;
  applications: { key: string; name: string; applicationId: string; url: string }[];
  mailpit: boolean;
  created: boolean;
  warnings: string[];
};

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
      .once('error', () => resolve(false))
      .listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
const anyPort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

export class DemoService {
  private procs = new Map<string, { child: ChildProcess; url: string }>();
  private starting = new Map<string, Promise<string>>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly config: ServerConfig,
    private readonly email: EmailService,
    private readonly bus: EventBus,
  ) {}

  private loadedIds(): Record<string, string> {
    const ids = getSetting<Record<string, string>>(this.db, 'demoApplications', {});
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(ids)) {
      try {
        repo.getApplication(this.db, id);
        out[k] = id;
      } catch {
        // deleted
      }
    }
    return out;
  }

  status(): DemoStatus {
    const ids = this.loadedIds();
    const apps = DEMO_APPS.map((a) => {
      const p = this.procs.get(a.key);
      return {
        key: a.key,
        name: a.name,
        applicationId: ids[a.key] ?? null,
        running: !!p && p.child.exitCode === null,
        url: p?.url ?? null,
      };
    });
    return {
      available: DEMO_APPS.every((a) => existsSync(a.workspace) && existsSync(a.main)),
      loaded: Object.keys(ids).length > 0,
      applicationId: ids.clinic ?? null,
      apps,
      clinic: { running: apps[0]!.running, url: apps[0]!.url },
    };
  }

  /** Starts one demo app (once) on its usual port, or on a free port when that one is taken. */
  startApp(key: string): Promise<string> {
    const app = DEMO_APPS.find((a) => a.key === key)!;
    const running = this.procs.get(key);
    if (running && running.child.exitCode === null) return Promise.resolve(running.url);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const port = (await portFree(app.port)) ? app.port : await anyPort();
      mkdirSync(join(this.config.dataDir, 'demo'), { recursive: true });
      const child = spawn(process.execPath, ['--import', 'tsx', app.main], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...app.env(port, join(this.config.dataDir, 'demo', `${app.key}.db`), this.config),
        },
        stdio: 'ignore',
      });
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`The ${app.name} demo app stopped while starting`);
        if (
          await fetch(`${url}/api/health`)
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        if (Date.now() > deadline) {
          child.kill();
          throw new Error(`The ${app.name} demo app did not start within 30 s`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      this.procs.set(key, { child, url });
      child.once('exit', () => this.procs.delete(key));
      // Keep the demo environment pointing at wherever the app runs now.
      const appId = this.loadedIds()[key];
      if (appId)
        for (const env of repo.listEnvironments(this.db, appId))
          if (env.baseUrl !== url && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.baseUrl))
            repo.updateEnvironment(this.db, env.id, { baseUrl: url });
      return url;
    })().finally(() => this.starting.delete(key));
    this.starting.set(key, promise);
    return promise;
  }

  /** CareClinic (kept for callers from the first demo version). */
  startClinic(): Promise<string> {
    return this.startApp('clinic');
  }

  /** Starts every demo app; used when StepForge starts with a loaded demo workspace. */
  async startAll(): Promise<void> {
    const ids = this.loadedIds();
    await Promise.all(DEMO_APPS.filter((a) => ids[a.key]).map((a) => this.startApp(a.key)));
  }

  /** Loads the demo workspace (idempotent: a second call only starts the apps again). */
  async load(): Promise<DemoLoaded> {
    const warnings: string[] = [];
    let mailpit = false;
    setSetting(this.db, 'mailpitAutostart', true);
    try {
      await this.email.mailpit.start();
      mailpit = true;
    } catch (err) {
      warnings.push(
        `Mailpit did not start (${(err as Error).message}); the email scenarios need it — see Settings → Email.`,
      );
    }
    const ids = this.loadedIds();
    let created = false;
    const applications: DemoLoaded['applications'] = [];
    for (const app of DEMO_APPS) {
      const url = await this.startApp(app.key);
      if (ids[app.key]) {
        applications.push({ key: app.key, name: app.name, applicationId: ids[app.key]!, url });
        continue;
      }
      const data = JSON.parse(readFileSync(app.workspace, 'utf8')) as { environments: { baseUrl: string }[] };
      for (const e of data.environments) e.baseUrl = url;
      let slug = app.slug;
      for (let i = 2; repo.getApplicationBySlug(this.db, slug); i++) slug = `${app.slug}-${i}`;
      const imported = repo.importApplication(this.db, data, { slug });
      const env = repo.listEnvironments(this.db, imported.applicationId)[0]!;
      for (const [key, value] of Object.entries(app.secrets))
        repo.setSecret(this.db, this.masterKey, env.id, { key, value });
      repo.createConnection(
        this.db,
        this.masterKey,
        env.id,
        {
          name: app.connection,
          engine: 'sqlite',
          database: join(this.config.dataDir, 'demo', `${app.key}.db`),
          readOnly: true,
          rollbackMode: true,
        },
        this.config.dbFile === ':memory:' ? undefined : this.config.dbFile,
      );
      saveGate(this.db, imported.applicationId, DEFAULT_GATE);
      ids[app.key] = imported.applicationId;
      setSetting(this.db, 'demoApplications', ids);
      created = true;
      applications.push({ key: app.key, name: app.name, applicationId: imported.applicationId, url });
      this.bus.publish({ type: 'tree.changed', applicationId: imported.applicationId });
    }
    setSetting(this.db, 'onboardingComplete', true);
    return {
      applicationId: applications[0]!.applicationId,
      clinicUrl: applications[0]!.url,
      applications,
      mailpit,
      created,
      warnings,
    };
  }

  stop(): void {
    for (const p of this.procs.values()) p.child.kill();
    this.procs.clear();
  }
}
