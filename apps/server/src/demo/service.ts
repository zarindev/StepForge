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
 * The demo workspace (first-run onboarding, `npm start -- --demo`). Sample data only on an explicit request:
 * starts the CareClinic demo app, imports its scenarios and adds what an export never carries — the demo
 * credentials (public demo data, stored encrypted like any secret), the SQLite connection and a quality gate.
 */
export const DEMO_WORKSPACE = join(REPO_ROOT, 'demo/clinic-app/stepforge/workspace.json');
const CLINIC_MAIN = join(REPO_ROOT, 'demo/clinic-app/src/main.ts');
/** CareClinic's documented demo accounts (see the demo app's login page). */
const DEMO_SECRETS = { password: 'Reception123!', adminPassword: 'Admin123!' };
const PREFERRED_PORT = 8101;

export type DemoStatus = {
  available: boolean;
  loaded: boolean;
  applicationId: string | null;
  clinic: { running: boolean; url: string | null };
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
  private clinic?: ChildProcess;
  private clinicUrl: string | null = null;
  private starting?: Promise<string>;

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly config: ServerConfig,
    private readonly email: EmailService,
    private readonly bus: EventBus,
  ) {}

  private loadedAppId(): string | null {
    const id = getSetting<string | null>(this.db, 'demoApplicationId', null);
    if (!id) return null;
    try {
      repo.getApplication(this.db, id);
      return id;
    } catch {
      return null; // the demo application was deleted
    }
  }

  status(): DemoStatus {
    return {
      available: existsSync(DEMO_WORKSPACE) && existsSync(CLINIC_MAIN),
      loaded: this.loadedAppId() !== null,
      applicationId: this.loadedAppId(),
      clinic: { running: !!this.clinic && this.clinic.exitCode === null, url: this.clinicUrl },
    };
  }

  /** Starts CareClinic (once) on 8101, or on a free port when 8101 is taken, with its data under data/demo. */
  startClinic(): Promise<string> {
    if (this.clinic && this.clinic.exitCode === null && this.clinicUrl)
      return Promise.resolve(this.clinicUrl);
    this.starting ??= (async () => {
      const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyPort();
      mkdirSync(join(this.config.dataDir, 'demo'), { recursive: true });
      const child = spawn(process.execPath, ['--import', 'tsx', CLINIC_MAIN], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CLINIC_PORT: String(port),
          CLINIC_DB: join(this.config.dataDir, 'demo', 'clinic.db'),
          CLINIC_SMTP_PORT: String(this.config.mailpit.smtpPort),
        },
        stdio: 'ignore',
      });
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error('The CareClinic demo app stopped while starting');
        if (
          await fetch(`${url}/api/health`)
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        if (Date.now() > deadline) {
          child.kill();
          throw new Error('The CareClinic demo app did not start within 30 s');
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      this.clinic = child;
      this.clinicUrl = url;
      child.once('exit', () => {
        this.clinic = undefined;
        this.clinicUrl = null;
      });
      // Keep the demo environment pointing at wherever CareClinic runs now.
      const appId = this.loadedAppId();
      if (appId)
        for (const env of repo.listEnvironments(this.db, appId))
          if (env.baseUrl !== url && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.baseUrl))
            repo.updateEnvironment(this.db, env.id, { baseUrl: url });
      return url;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Loads the demo workspace (idempotent: a second call only starts the apps again). */
  async load(): Promise<{
    applicationId: string;
    clinicUrl: string;
    mailpit: boolean;
    created: boolean;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    let mailpit = false;
    setSetting(this.db, 'mailpitAutostart', true);
    try {
      await this.email.mailpit.start();
      mailpit = true;
    } catch (err) {
      warnings.push(
        `Mailpit did not start (${(err as Error).message}); the email scenario needs it — see Settings → Email.`,
      );
    }
    const clinicUrl = await this.startClinic();
    const existing = this.loadedAppId();
    if (existing) return { applicationId: existing, clinicUrl, mailpit, created: false, warnings };

    const data = JSON.parse(readFileSync(DEMO_WORKSPACE, 'utf8')) as { environments: { baseUrl: string }[] };
    for (const e of data.environments) e.baseUrl = clinicUrl;
    // Another application may already use the slug (e.g. an earlier, deleted-setting demo): pick a free one.
    let slug = 'careclinic';
    for (let i = 2; repo.getApplicationBySlug(this.db, slug); i++) slug = `careclinic-${i}`;
    const imported = repo.importApplication(this.db, data, { slug });
    const env = repo.listEnvironments(this.db, imported.applicationId)[0]!;
    for (const [key, value] of Object.entries(DEMO_SECRETS))
      repo.setSecret(this.db, this.masterKey, env.id, { key, value });
    repo.createConnection(
      this.db,
      this.masterKey,
      env.id,
      {
        name: 'clinic',
        engine: 'sqlite',
        database: join(this.config.dataDir, 'demo', 'clinic.db'),
        readOnly: true,
        rollbackMode: true,
      },
      this.config.dbFile === ':memory:' ? undefined : this.config.dbFile,
    );
    saveGate(this.db, imported.applicationId, DEFAULT_GATE);
    setSetting(this.db, 'demoApplicationId', imported.applicationId);
    setSetting(this.db, 'onboardingComplete', true);
    this.bus.publish({ type: 'tree.changed', applicationId: imported.applicationId });
    return { applicationId: imported.applicationId, clinicUrl, mailpit, created: true, warnings };
  }

  stop(): void {
    this.clinic?.kill();
    this.clinic = undefined;
    this.clinicUrl = null;
  }
}
