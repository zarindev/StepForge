import { InboxInput } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { ImapMailbox, MailpitMailbox, MailpitServer, installMailpit, type Mailbox } from '@stepforge/email';
import type { InboxResolver } from '@stepforge/executor-email';
import { join } from 'node:path';
import type { z } from 'zod';

/** HTTP status for email errors (matched by name: workspace symlinks can load a module twice). */
export function emailHttpError(err: unknown): Error {
  const e = err as Error & { code?: string };
  if (e.name !== 'EmailError') return e;
  return new repo.RepoError(
    e.code === 'connection' ? 502 : e.code === 'not_found' ? 404 : 400,
    e.code === 'connection' ? 'email_unreachable' : (e.code ?? 'email_error'),
    e.message,
  );
}

/** Local Mailpit control, inboxes per application, and mailboxes for runs and the inbox viewer. */
export class EmailService {
  readonly mailpit: MailpitServer;
  private installing: Promise<string> | null = null;

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly dataDir: string,
    private readonly binDir: string,
    ports: { httpPort: number; smtpPort: number },
  ) {
    this.mailpit = new MailpitServer({
      binDir,
      dataDir: join(dataDir, 'mailpit'),
      ...ports,
    });
  }

  /** Downloads the pinned Mailpit into data/bin (one download at a time). */
  async install(): Promise<void> {
    this.installing ??= installMailpit(this.binDir).finally(() => (this.installing = null));
    await this.installing;
  }

  /** The built-in local inbox: StepForge's own Mailpit. */
  localMailbox(): Mailbox {
    return new MailpitMailbox(this.mailpit.url);
  }

  mailboxFor(
    inbox: repo.ResolvedInbox | { kind: 'mailpit' | 'imap'; config: repo.InboxConfig; password?: string },
  ): Mailbox {
    if (inbox.kind === 'mailpit') return new MailpitMailbox(inbox.config.url?.trim() || this.mailpit.url);
    return new ImapMailbox({
      host: inbox.config.host ?? '',
      port: inbox.config.port,
      secure: inbox.config.secure,
      user: inbox.config.user ?? '',
      password: inbox.password,
      mailbox: inbox.config.mailbox,
      allowSelfSigned: inbox.config.allowSelfSigned,
    });
  }

  /** `inboxId` "local" means the built-in Mailpit. */
  mailbox(inboxId: string): Mailbox {
    if (inboxId === 'local') return this.localMailbox();
    try {
      return this.mailboxFor(repo.resolveInbox(this.db, this.masterKey, inboxId));
    } catch (err) {
      throw emailHttpError(err);
    }
  }

  draftMailbox(input: z.input<typeof InboxInput>, inboxId?: string): Mailbox {
    const d = InboxInput.parse(input);
    const password =
      d.password ?? (inboxId ? repo.resolveInbox(this.db, this.masterKey, inboxId).password : undefined);
    return this.mailboxFor({ kind: d.kind, config: d.config, password });
  }

  async test(make: () => Mailbox): Promise<{ ok: boolean; message: string }> {
    let box: Mailbox | undefined;
    try {
      box = make();
      return { ok: true, message: await box.check() };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      await box?.close().catch(() => undefined);
    }
  }

  /**
   * Email steps name an inbox; without a name they use the application's first inbox, or StepForge's local
   * Mailpit when the application has none.
   */
  resolverFor(applicationId: string): InboxResolver {
    return async (ref) => {
      if (ref) {
        const row = repo.findInbox(this.db, applicationId, ref);
        if (!row) throw new Error(`No inbox named "${ref}" in this application (add it on the Inboxes tab)`);
        return this.mailbox(row.id);
      }
      const first = repo.listInboxes(this.db, applicationId)[0];
      return first ? this.mailbox(first.id) : this.localMailbox();
    };
  }
}
