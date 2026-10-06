import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@stepforge/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getSetting, openDatabase, schema, setSetting } from '../src/index.ts';

describe('database', () => {
  it('migrates a fresh in-memory database', () => {
    const { db, applied } = openDatabase({ file: ':memory:' });
    expect(applied).toBeGreaterThan(0);
    expect(db.select().from(schema.applications).all()).toEqual([]);
  });

  it('round-trips JSON columns and cascades deletes', () => {
    const { db } = openDatabase({ file: ':memory:' });
    const appId = newId();
    db.insert(schema.applications)
      .values({ id: appId, name: 'Clinic', slug: 'clinic', tagsJson: ['demo'] })
      .run();
    db.insert(schema.environments)
      .values({
        id: newId(),
        applicationId: appId,
        name: 'Local',
        baseUrl: 'http://localhost:8101',
        variablesJson: { a: '1' },
      })
      .run();
    const env = db.select().from(schema.environments).get();
    expect(env?.variablesJson).toEqual({ a: '1' });
    expect(env?.isProduction).toBe(false);
    expect(env?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    db.delete(schema.applications).where(eq(schema.applications.id, appId)).run();
    expect(db.select().from(schema.environments).all()).toHaveLength(0);
  });

  it('enforces foreign keys', () => {
    const { db } = openDatabase({ file: ':memory:' });
    expect(() =>
      db
        .insert(schema.environments)
        .values({ id: newId(), applicationId: 'missing', name: 'x', baseUrl: 'y' })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('stores settings', () => {
    const { db } = openDatabase({ file: ':memory:' });
    expect(getSetting(db, 'theme', 'dark')).toBe('dark');
    setSetting(db, 'theme', 'light');
    setSetting(db, 'theme', { mode: 'light' });
    expect(getSetting(db, 'theme', null)).toEqual({ mode: 'light' });
  });

  it('applies migrations once on a file database and backs up only when needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-db-'));
    const file = join(dir, 'stepforge.db');
    const first = openDatabase({ file });
    expect(first.backupPath).toBeNull(); // fresh DB: nothing to back up
    first.sqlite.close();
    const second = openDatabase({ file });
    expect(second.applied).toBe(0);
    expect(second.backupPath).toBeNull();
    second.sqlite.close();
    expect(readdirSync(dir)).not.toContain('backups');
  });
});
