import { decrypt, encrypt } from '@stepforge/crypto';
import { EnvironmentInput, EnvironmentUpdate, newId, SecretInput } from '@stepforge/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, environments, secrets } from '../schema.ts';
import { notFound, now } from './errors.ts';

export type Environment = typeof environments.$inferSelect;
/** Secrets are never returned in plaintext: only key + metadata. */
export type SecretMeta = { id: string; environmentId: string | null; key: string; updatedAt: string };

export function listEnvironments(db: StepForgeDb, applicationId: string): Environment[] {
  return db
    .select()
    .from(environments)
    .where(eq(environments.applicationId, applicationId))
    .orderBy(environments.createdAt)
    .all();
}

export function getEnvironment(db: StepForgeDb, id: string): Environment {
  const env = db.select().from(environments).where(eq(environments.id, id)).get();
  if (!env) throw notFound('Environment', id);
  return env;
}

export function createEnvironment(
  db: StepForgeDb,
  applicationId: string,
  input: z.input<typeof EnvironmentInput>,
): Environment {
  if (
    !db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()
  ) {
    throw notFound('Application', applicationId);
  }
  const d = EnvironmentInput.parse(input);
  const id = newId();
  db.insert(environments)
    .values({
      id,
      applicationId,
      name: d.name,
      baseUrl: d.baseUrl,
      isProduction: d.isProduction,
      variablesJson: d.variables,
      browserDefaultsJson: d.browserDefaults,
    })
    .run();
  return getEnvironment(db, id);
}

export function updateEnvironment(
  db: StepForgeDb,
  id: string,
  input: z.input<typeof EnvironmentUpdate>,
): Environment {
  getEnvironment(db, id);
  const d = EnvironmentUpdate.parse(input);
  db.update(environments)
    .set({
      ...(d.name !== undefined && { name: d.name }),
      ...(d.baseUrl !== undefined && { baseUrl: d.baseUrl }),
      ...(d.isProduction !== undefined && { isProduction: d.isProduction }),
      ...(d.variables !== undefined && { variablesJson: d.variables }),
      ...(d.browserDefaults !== undefined && { browserDefaultsJson: d.browserDefaults }),
      updatedAt: now(),
    })
    .where(eq(environments.id, id))
    .run();
  return getEnvironment(db, id);
}

export function deleteEnvironment(db: StepForgeDb, id: string): void {
  getEnvironment(db, id);
  db.delete(environments).where(eq(environments.id, id)).run();
}

// ─── Secrets ───────────────────────────────────────────────────────────────

const toMeta = (s: typeof secrets.$inferSelect): SecretMeta => ({
  id: s.id,
  environmentId: s.environmentId,
  key: s.key,
  updatedAt: s.updatedAt,
});

export function listSecrets(db: StepForgeDb, environmentId: string): SecretMeta[] {
  return db
    .select()
    .from(secrets)
    .where(eq(secrets.environmentId, environmentId))
    .orderBy(secrets.key)
    .all()
    .map(toMeta);
}

/** Creates or replaces the secret `key` in an environment. */
export function setSecret(
  db: StepForgeDb,
  masterKey: Buffer,
  environmentId: string,
  input: z.input<typeof SecretInput>,
): SecretMeta {
  getEnvironment(db, environmentId);
  const { key, value } = SecretInput.parse(input);
  const enc = encrypt(value, masterKey);
  const existing = db
    .select()
    .from(secrets)
    .where(and(eq(secrets.environmentId, environmentId), eq(secrets.key, key)))
    .get();
  if (existing) {
    db.update(secrets)
      .set({ ...enc, updatedAt: now() })
      .where(eq(secrets.id, existing.id))
      .run();
    return toMeta({ ...existing, updatedAt: now() });
  }
  const id = newId();
  db.insert(secrets)
    .values({ id, environmentId, key, ...enc })
    .run();
  return toMeta(db.select().from(secrets).where(eq(secrets.id, id)).get()!);
}

export function deleteSecret(db: StepForgeDb, id: string): void {
  const s = db.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, id)).get();
  if (!s) throw notFound('Secret', id);
  db.delete(secrets).where(eq(secrets.id, id)).run();
}

/** Decrypts every secret of an environment. Only for the run engine — never send this to the UI. */
export function resolveSecrets(
  db: StepForgeDb,
  masterKey: Buffer,
  environmentId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of db.select().from(secrets).where(eq(secrets.environmentId, environmentId)).all()) {
    out[s.key] = decrypt(s, masterKey);
  }
  return out;
}
