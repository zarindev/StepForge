import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

export * as schema from './schema.ts';
export type StepForgeDb = BetterSQLite3Database<typeof schema>;

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const MAX_BACKUPS = 10;

export type OpenDbOptions = {
  /** Path to the SQLite file, or ':memory:'. */
  file: string;
  /** Folder for pre-migration backups. Defaults to `<db dir>/backups`. */
  backupDir?: string;
  log?: (msg: string) => void;
};

export type OpenedDb = {
  db: StepForgeDb;
  sqlite: Database.Database;
  backupPath: string | null;
  applied: number;
};

function pendingMigrationCount(sqlite: Database.Database): number {
  const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (!hasTable) return all.length;
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
  return Math.max(0, all.length - row.n);
}

function backup(sqlite: Database.Database, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `stepforge-${stamp}.db`);
  // VACUUM INTO produces a consistent, compact copy even in WAL mode.
  sqlite.prepare('VACUUM INTO ?').run(path);
  const old = readdirSync(dir)
    .filter((f) => f.startsWith('stepforge-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .slice(MAX_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return path;
}

/**
 * Opens (and creates if missing) the StepForge database, enables WAL + foreign keys and applies
 * pending migrations. An existing database is backed up before any migration runs (Section 10).
 */
export function openDatabase(opts: OpenDbOptions): OpenedDb {
  const inMemory = opts.file === ':memory:';
  const existed = !inMemory && existsSync(opts.file);
  if (!inMemory) mkdirSync(dirname(opts.file), { recursive: true });

  const sqlite = new Database(opts.file);
  if (!inMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const pending = pendingMigrationCount(sqlite);
  let backupPath: string | null = null;
  if (pending > 0 && existed) {
    backupPath = backup(sqlite, opts.backupDir ?? join(dirname(opts.file), 'backups'));
    opts.log?.(`Backed up database to ${backupPath} before applying ${pending} migration(s)`);
  }

  const db = drizzle(sqlite, { schema });
  if (pending > 0) migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite, backupPath, applied: pending };
}

/** Typed key/value settings stored in the `settings` table. */
export function getSetting<T>(db: StepForgeDb, key: string, fallback: T): T {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row ? (row.valueJson as T) : fallback;
}

export function setSetting(db: StepForgeDb, key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { valueJson: value, updatedAt: new Date().toISOString() },
    })
    .run();
}
