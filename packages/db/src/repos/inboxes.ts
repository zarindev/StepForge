import { decrypt, encrypt } from '@stepforge/crypto';
import { InboxInput, InboxUpdate, newId } from '@stepforge/core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, mailInboxes, secrets } from '../schema.ts';
import { mapUnique, notFound, now } from './errors.ts';

type Row = typeof mailInboxes.$inferSelect;
export type InboxConfig = z.infer<typeof InboxInput>['config'];
/** What the UI sees: never the password. */
export type InboxView = Omit<Row, 'secretId' | 'configJson'> & { config: InboxConfig; hasPassword: boolean };
export type ResolvedInbox = {
  id: string;
  name: string;
  kind: Row['kind'];
  config: InboxConfig;
  password?: string;
};

export const INBOX_SECRET_PREFIX = 'mail-inbox:';

const view = ({ secretId, configJson, ...r }: Row): InboxView => ({
  ...r,
  config: configJson as InboxConfig,
  hasPassword: !!secretId,
});

function getRow(db: StepForgeDb, id: string): Row {
  const row = db.select().from(mailInboxes).where(eq(mailInboxes.id, id)).get();
  if (!row) throw notFound('Inbox', id);
  return row;
}

export function listInboxes(db: StepForgeDb, applicationId: string): InboxView[] {
  return db
    .select()
    .from(mailInboxes)
    .where(eq(mailInboxes.applicationId, applicationId))
    .orderBy(mailInboxes.createdAt)
    .all()
    .map(view);
}

export const getInbox = (db: StepForgeDb, id: string): InboxView => view(getRow(db, id));

function storePassword(db: StepForgeDb, key: Buffer, inboxId: string, password: string): string {
  const id = newId();
  db.insert(secrets)
    .values({ id, environmentId: null, key: `${INBOX_SECRET_PREFIX}${inboxId}`, ...encrypt(password, key) })
    .run();
  return id;
}

export function createInbox(
  db: StepForgeDb,
  masterKey: Buffer,
  applicationId: string,
  input: z.input<typeof InboxInput>,
): InboxView {
  if (!db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get())
    throw notFound('Application', applicationId);
  const d = InboxInput.parse(input);
  const id = newId();
  db.transaction(() => {
    mapUnique(
      () =>
        db
          .insert(mailInboxes)
          .values({ id, applicationId, name: d.name, kind: d.kind, configJson: d.config })
          .run(),
      `An inbox named "${d.name}" already exists`,
    );
    if (d.password)
      db.update(mailInboxes)
        .set({ secretId: storePassword(db, masterKey, id, d.password) })
        .where(eq(mailInboxes.id, id))
        .run();
  });
  return getInbox(db, id);
}

export function updateInbox(
  db: StepForgeDb,
  masterKey: Buffer,
  id: string,
  input: z.input<typeof InboxUpdate>,
): InboxView {
  const row = getRow(db, id);
  const d = InboxUpdate.parse(input);
  db.transaction(() => {
    let secretId = row.secretId;
    if (d.password !== undefined) {
      if (row.secretId) db.delete(secrets).where(eq(secrets.id, row.secretId)).run();
      secretId = d.password ? storePassword(db, masterKey, id, d.password) : null;
    }
    mapUnique(
      () =>
        db
          .update(mailInboxes)
          .set({
            ...(d.name !== undefined && { name: d.name }),
            ...(d.kind !== undefined && { kind: d.kind }),
            ...(d.config !== undefined && { configJson: d.config }),
            secretId,
            updatedAt: now(),
          })
          .where(eq(mailInboxes.id, id))
          .run(),
      `An inbox named "${d.name}" already exists`,
    );
  });
  return getInbox(db, id);
}

export function deleteInbox(db: StepForgeDb, id: string): void {
  const row = getRow(db, id);
  db.transaction(() => {
    db.delete(mailInboxes).where(eq(mailInboxes.id, id)).run();
    if (row.secretId) db.delete(secrets).where(eq(secrets.id, row.secretId)).run();
  });
}

/** Decrypts an inbox for use. Server-side only. */
export function resolveInbox(db: StepForgeDb, masterKey: Buffer, id: string): ResolvedInbox {
  const row = getRow(db, id);
  const secret = row.secretId
    ? db.select().from(secrets).where(eq(secrets.id, row.secretId)).get()
    : undefined;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.configJson as InboxConfig,
    ...(secret && { password: decrypt(secret, masterKey) }),
  };
}

export function findInbox(db: StepForgeDb, applicationId: string, name: string): Row | undefined {
  return db
    .select()
    .from(mailInboxes)
    .where(and(eq(mailInboxes.applicationId, applicationId), eq(mailInboxes.name, name)))
    .get();
}

/** Inbox passwords live outside any environment, so deleting an application removes them explicitly. */
export function purgeInboxSecrets(db: StepForgeDb, applicationId: string): void {
  const ids = db
    .select({ id: mailInboxes.secretId })
    .from(mailInboxes)
    .where(and(eq(mailInboxes.applicationId, applicationId), isNotNull(mailInboxes.secretId)))
    .all()
    .map((r) => r.id!);
  if (ids.length) db.delete(secrets).where(inArray(secrets.id, ids)).run();
}
