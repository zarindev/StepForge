import { decrypt, encrypt } from '@stepforge/crypto';
import { newId } from '@stepforge/core';
import { desc, eq } from 'drizzle-orm';
import type { StepForgeDb } from '../index.ts';
import { notifyChannels, runs, schedules, secrets } from '../schema.ts';
import { notFound, now } from './errors.ts';

// ─── Notification channels ────────────────────────────────────────────────
type ChannelRow = typeof notifyChannels.$inferSelect;
export type ChannelView = {
  id: string;
  name: string;
  kind: ChannelRow['kind'];
  config: Record<string, unknown>;
  on: 'always' | 'failures';
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ChannelData = {
  name: string;
  kind: ChannelRow['kind'];
  config: Record<string, unknown>;
  on: 'always' | 'failures';
  /** Bot token / SMTP password. Undefined keeps the stored one, null removes it. */
  secret?: string | null;
};

const channelView = (r: ChannelRow): ChannelView => {
  const c = r.configJson as { config?: Record<string, unknown>; on?: 'always' | 'failures' };
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    config: c.config ?? {},
    on: c.on ?? 'always',
    hasSecret: !!r.secretId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
};

function channelRow(db: StepForgeDb, id: string): ChannelRow {
  const r = db.select().from(notifyChannels).where(eq(notifyChannels.id, id)).get();
  if (!r) throw notFound('Notification channel', id);
  return r;
}

export const listChannels = (db: StepForgeDb) =>
  db.select().from(notifyChannels).orderBy(notifyChannels.createdAt).all().map(channelView);
export const getChannel = (db: StepForgeDb, id: string) => channelView(channelRow(db, id));

export function saveChannel(db: StepForgeDb, masterKey: Buffer, d: ChannelData, id?: string): ChannelView {
  const existing = id ? channelRow(db, id) : undefined;
  const channelId = existing?.id ?? newId();
  db.transaction(() => {
    let secretId = existing?.secretId ?? null;
    if (d.secret !== undefined) {
      if (secretId) db.delete(secrets).where(eq(secrets.id, secretId)).run();
      secretId = null;
      if (d.secret) {
        secretId = newId();
        db.insert(secrets)
          .values({
            id: secretId,
            environmentId: null,
            key: `notify-channel:${channelId}`,
            ...encrypt(d.secret, masterKey),
          })
          .run();
      }
    }
    const values = {
      name: d.name,
      kind: d.kind,
      configJson: { config: d.config, on: d.on },
      secretId,
      updatedAt: now(),
    };
    if (existing) db.update(notifyChannels).set(values).where(eq(notifyChannels.id, channelId)).run();
    else
      db.insert(notifyChannels)
        .values({ id: channelId, ...values })
        .run();
  });
  return getChannel(db, channelId);
}

export function deleteChannel(db: StepForgeDb, id: string): void {
  const r = channelRow(db, id);
  db.transaction(() => {
    db.delete(notifyChannels).where(eq(notifyChannels.id, id)).run();
    if (r.secretId) db.delete(secrets).where(eq(secrets.id, r.secretId)).run();
  });
}

/** The channel with its secret decrypted. Server-side only. */
export function resolveChannel(db: StepForgeDb, masterKey: Buffer, id: string) {
  const r = channelRow(db, id);
  const s = r.secretId ? db.select().from(secrets).where(eq(secrets.id, r.secretId)).get() : undefined;
  return { ...channelView(r), secret: s ? decrypt(s, masterKey) : undefined };
}

// ─── Schedules ────────────────────────────────────────────────────────────
export type Schedule = typeof schedules.$inferSelect;
export type ScheduleData = {
  name: string;
  environmentId: string;
  cron: string;
  scope: Record<string, unknown>;
  options: Record<string, unknown>;
  enabled: boolean;
  channelIds: string[];
};

export function listSchedules(db: StepForgeDb, applicationId?: string): Schedule[] {
  const q = db.select().from(schedules);
  return (applicationId ? q.where(eq(schedules.applicationId, applicationId)) : q)
    .orderBy(schedules.createdAt)
    .all();
}

export function getSchedule(db: StepForgeDb, id: string): Schedule {
  const s = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!s) throw notFound('Schedule', id);
  return s;
}

export function saveSchedule(db: StepForgeDb, applicationId: string, d: ScheduleData, id?: string): Schedule {
  const values = {
    name: d.name,
    environmentId: d.environmentId,
    cron: d.cron,
    scopeJson: d.scope,
    optionsJson: d.options,
    enabled: d.enabled,
    notifyChannelIdsJson: d.channelIds,
    updatedAt: now(),
  };
  if (id) {
    getSchedule(db, id);
    db.update(schedules).set(values).where(eq(schedules.id, id)).run();
    return getSchedule(db, id);
  }
  const newSchedule = newId();
  db.insert(schedules)
    .values({ id: newSchedule, applicationId, ...values })
    .run();
  return getSchedule(db, newSchedule);
}

export function setScheduleState(
  db: StepForgeDb,
  id: string,
  patch: { lastRunId?: string; nextRunAt?: string | null },
) {
  db.update(schedules).set(patch).where(eq(schedules.id, id)).run();
}

export function deleteSchedule(db: StepForgeDb, id: string): void {
  getSchedule(db, id);
  db.delete(schedules).where(eq(schedules.id, id)).run();
}

export function scheduleRuns(db: StepForgeDb, scheduleId: string, limit = 20) {
  return db
    .select()
    .from(runs)
    .where(eq(runs.scheduleId, scheduleId))
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .all();
}
