import { generateKey, rotate } from '@stepforge/crypto';
import { getSetting, schema, type StepForgeDb } from '@stepforge/db';
import type Database from 'better-sqlite3';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { copyFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ServerConfig } from '../config.ts';

type Retention = { keepFailures: boolean; prunePassesAfterDays: number };
const DAY = 86_400_000;

/**
 * Housekeeping: artifact retention (daily), master-key rotation and the danger zone. Run history (results, timings,
 * diagnoses) is kept by retention; only evidence files (screenshots, videos, traces…) of old results are removed.
 */
export class MaintenanceService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: StepForgeDb,
    private readonly sqlite: Database.Database,
    private readonly config: ServerConfig,
    private readonly masterKey: Buffer,
  ) {}

  /** Inside the artifacts folder only (paths come from the database). */
  private removeFile(rel: string | null | undefined): number {
    if (!rel) return 0;
    const root = resolve(this.config.artifactsDir);
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep) || !existsSync(file)) return 0;
    const size = statSync(file).size;
    rmSync(file, { force: true });
    return size;
  }

  /** Removes evidence of results older than the retention period: passes, and failures unless kept. */
  prune(now = Date.now()): { items: number; files: number; bytes: number } {
    const r = getSetting<Retention>(this.db, 'retention', { keepFailures: true, prunePassesAfterDays: 14 });
    const cutoff = new Date(now - r.prunePassesAfterDays * DAY).toISOString();
    type Status = 'passed' | 'skipped' | 'flaky' | 'failed' | 'broken';
    const statuses: Status[] = r.keepFailures
      ? ['passed', 'skipped', 'flaky']
      : ['passed', 'skipped', 'flaky', 'failed', 'broken'];
    const items = this.db
      .select({ id: schema.runItems.id })
      .from(schema.runItems)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.runItems.runId))
      .where(
        and(
          inArray(schema.runItems.status, statuses),
          isNotNull(schema.runs.finishedAt),
          lt(schema.runs.finishedAt, cutoff),
        ),
      )
      .all()
      .map((x) => x.id);
    let files = 0;
    let bytes = 0;
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      const arts = this.db
        .select()
        .from(schema.artifacts)
        .where(inArray(schema.artifacts.runItemId, chunk))
        .all();
      const shots = this.db
        .select({ id: schema.stepResults.id, path: schema.stepResults.screenshotPath })
        .from(schema.stepResults)
        .where(
          and(inArray(schema.stepResults.runItemId, chunk), isNotNull(schema.stepResults.screenshotPath)),
        )
        .all();
      for (const p of [...arts.map((a) => a.path), ...shots.map((s) => s.path)]) {
        const size = this.removeFile(p);
        if (size) files++;
        bytes += size;
      }
      this.db.transaction(() => {
        this.db.delete(schema.artifacts).where(inArray(schema.artifacts.runItemId, chunk)).run();
        this.db
          .update(schema.stepResults)
          .set({ screenshotPath: null })
          .where(inArray(schema.stepResults.runItemId, chunk))
          .run();
      });
    }
    return { items: items.length, files, bytes };
  }

  /** Prunes now and then once a day while StepForge runs. */
  startRetention(log: (m: string) => void): void {
    const run = () => {
      try {
        const r = this.prune();
        if (r.files)
          log(
            `Retention: removed ${r.files} evidence file(s) (${Math.round(r.bytes / 1024)} KB) of ${r.items} old result(s)`,
          );
      } catch (err) {
        log(`Retention failed: ${(err as Error).message}`);
      }
    };
    setTimeout(run, 10_000).unref();
    this.timer = setInterval(run, DAY);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Re-encrypts every secret with a new master key. The new key is written next to the old one first, the old key
   * is kept as a backup, and the swap happens only after the database transaction succeeded.
   */
  rotateKey(): { secrets: number; backup: string } {
    const newKey = generateKey();
    const temp = `${this.config.keyFile}.new`;
    writeFileSync(temp, newKey.toString('base64'), { mode: 0o600 });
    const rows = this.db.select().from(schema.secrets).all();
    try {
      this.db.transaction(() => {
        for (const s of rows) {
          const r = rotate({ ciphertext: s.ciphertext, iv: s.iv, tag: s.tag }, this.masterKey, newKey);
          this.db.update(schema.secrets).set(r).where(eq(schema.secrets.id, s.id)).run();
        }
      });
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    const backup = `${this.config.keyFile}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(this.config.keyFile, backup);
    renameSync(temp, this.config.keyFile);
    // Every service holds this Buffer: update it in place.
    newKey.copy(this.masterKey);
    return { secrets: rows.length, backup };
  }

  /** Deletes all runs, results, evidence and bugs; applications and tests stay. */
  deleteRunHistory(): { runs: number } {
    const runs = this.db.select({ id: schema.runs.id }).from(schema.runs).all().length;
    this.db.transaction(() => {
      this.db.delete(schema.bugs).run();
      this.db.delete(schema.runs).run();
      this.db.delete(schema.analyticsDaily).run();
    });
    rmSync(join(this.config.artifactsDir, 'runs'), { recursive: true, force: true });
    return { runs };
  }

  /** Deletes every application (and with it all tests, environments, secrets and history) and the demo state. */
  deleteEverything(): { applications: number } {
    const applications = this.db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .all().length;
    this.db.transaction(() => {
      this.db.delete(schema.bugs).run();
      this.db.delete(schema.runs).run();
      this.db.delete(schema.applications).run();
      this.db.delete(schema.schedules).run();
      this.db.delete(schema.notifyChannels).run();
      this.db.delete(schema.secrets).run();
      this.db.delete(schema.analyticsDaily).run();
      this.db
        .delete(schema.settings)
        .where(inArray(schema.settings.key, ['demoApplicationId', 'onboardingComplete']))
        .run();
    });
    rmSync(join(this.config.artifactsDir, 'runs'), { recursive: true, force: true });
    this.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    return { applications };
  }
}
