import { StepError, type StepContext, type StepOutcome } from '@stepforge/core';
import { Client as FtpClient, type FileInfo } from 'basic-ftp';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import SftpClient from 'ssh2-sftp-client';

type Entry = { name: string; size: number; type: 'file' | 'directory' | 'other'; modifiedAt?: string };
const MAX_TEXT = 5 * 1024 * 1024;
const pad = (n: number) => String(n + 1).padStart(2, '0');

/** One connection, whichever protocol: the few operations a test needs. */
interface Remote {
  upload(from: Buffer | string, to: string): Promise<void>;
  download(from: string, to: string): Promise<void>;
  list(dir: string): Promise<Entry[]>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  close(): Promise<void>;
}

async function connect(p: Record<string, unknown>, timeoutMs: number): Promise<Remote> {
  const protocol = String(p.protocol ?? 'ftp');
  const host = String(p.host ?? '');
  if (!host) throw new StepError('invalid_params', 'FTP steps need a "host"');
  const user = String(p.username ?? 'anonymous');
  const password = String(p.password ?? '');
  if (protocol === 'sftp') {
    // Read the key first: a missing local key file must not look like a missing remote file.
    let privateKey: Buffer | undefined;
    if (p.privateKey) {
      try {
        privateKey = readFileSync(String(p.privateKey));
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw new StepError(
          'invalid_params',
          `Cannot read the private key ${String(p.privateKey)}: ${e.code ?? e.message}`,
        );
      }
    }
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host,
        port: Number(p.port || 22),
        username: user,
        ...(privateKey ? { privateKey } : { password }),
        readyTimeout: timeoutMs,
      });
    } catch (err) {
      // A failed login would otherwise leave the socket open.
      await sftp.end().catch(() => {});
      throw err;
    }
    return {
      upload: async (from, to) => void (await sftp.put(typeof from === 'string' ? from : from, to)),
      // Into memory first: get() with a local path can resolve before the file is written out (a 0-byte file).
      download: async (from, to) => writeFileSync(to, (await sftp.get(from)) as Buffer),
      list: async (dir) =>
        (await sftp.list(dir)).map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type === 'd' ? 'directory' : f.type === '-' ? 'file' : 'other',
          modifiedAt: new Date(f.modifyTime).toISOString(),
        })),
      remove: async (path) => void (await sftp.delete(path)),
      exists: async (path) => (await sftp.exists(path)) !== false,
      close: async () => void (await sftp.end()),
    };
  }
  const ftp = new FtpClient(timeoutMs);
  try {
    await ftp.access({
      host,
      port: Number(p.port || 21),
      user,
      password,
      secure: protocol === 'ftps',
      // Test servers often use self-signed certificates.
      secureOptions: { rejectUnauthorized: p.rejectUnauthorized === true },
    });
  } catch (err) {
    // A failed login would otherwise leave the socket open.
    ftp.close();
    throw err;
  }
  const entry = (f: FileInfo): Entry => ({
    name: f.name,
    size: f.size,
    type: f.isDirectory ? 'directory' : f.isFile ? 'file' : 'other',
    ...(f.modifiedAt && { modifiedAt: f.modifiedAt.toISOString() }),
  });
  return {
    upload: async (from, to) =>
      void (await ftp.uploadFrom(typeof from === 'string' ? from : Readable.from(from), to)),
    download: async (from, to) => void (await ftp.downloadTo(to, from)),
    list: async (dir) => (await ftp.list(dir)).map(entry),
    remove: async (path) => void (await ftp.remove(path)),
    exists: async (path) => {
      // Listed in its parent folder (files and folders alike); a missing parent means it does not exist.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.';
      let entries: FileInfo[];
      try {
        entries = await ftp.list(dir);
      } catch (err) {
        if (/550|No such file|not found|cannot find/i.test((err as Error).message ?? '')) return false;
        throw err;
      }
      return entries.some((f) => f.name === basename(path));
    },
    close: async () => ftp.close(),
  };
}

/**
 * FTP, FTPS and SFTP: `upload` (a local file, or `content` as text), `download` (kept as evidence; its text can be
 * checked), `list` a folder, `delete`, or check that a file `exists`.
 */
export async function ftpStep(
  p: Record<string, unknown>,
  ctx: StepContext,
  artifactsDir: string,
): Promise<StepOutcome> {
  const action = String(p.action ?? 'list');
  const remotePath = String(p.remotePath ?? (action === 'list' ? '.' : ''));
  if (!remotePath) throw new StepError('invalid_params', `ftp ${action} needs a "remotePath"`);
  const where = `${String(p.protocol ?? 'ftp')}://${String(p.host ?? '')}${remotePath.startsWith('/') ? '' : '/'}${remotePath}`;
  let remote: Remote | undefined;
  try {
    remote = await connect(p, ctx.timeoutMs);
    switch (action) {
      case 'upload': {
        const from =
          p.content !== undefined && p.content !== ''
            ? Buffer.from(String(p.content))
            : String(p.localPath ?? '');
        if (from === '') throw new StepError('invalid_params', 'ftp upload needs "localPath" or "content"');
        await remote.upload(from, remotePath);
        const size = typeof from === 'string' ? statSync(from).size : from.length;
        return { output: { remotePath, size }, message: `Uploaded ${size} bytes to ${where}` };
      }
      case 'download': {
        mkdirSync(artifactsDir, { recursive: true });
        const to = String(
          p.localPath || join(artifactsDir, `ftp-${pad(ctx.stepIndex)}-${basename(remotePath)}`),
        );
        await remote.download(remotePath, to);
        const size = statSync(to).size;
        let text: string | undefined;
        const content = () => (text ??= size <= MAX_TEXT ? readFileSync(to, 'utf8') : '');
        return {
          output: { path: to, size },
          message: `Downloaded ${where} (${size} bytes)`,
          getTarget: (t) =>
            t === 'size' ? size : t === 'content' ? content() : t === 'path' ? to : undefined,
        };
      }
      case 'list': {
        const entries = await remote.list(remotePath);
        return {
          output: entries,
          message: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${where}`,
          response: { body: entries },
          getTarget: (t) =>
            t === 'count' ? entries.length : t === 'names' ? entries.map((e) => e.name) : undefined,
        };
      }
      case 'delete':
        await remote.remove(remotePath);
        return { message: `Deleted ${where}` };
      case 'exists': {
        // "dir/" is "dir"; the root (and the login folder) always exist.
        const path = remotePath.replace(/\/+$/, '');
        const exists = path === '' || path === '.' ? true : await remote.exists(path);
        return {
          output: exists,
          message: `${where} ${exists ? 'exists' : 'does not exist'}`,
          getTarget: (t) => (t === 'exists' || t === 'value' ? exists : undefined),
        };
      }
      default:
        throw new StepError(
          'invalid_params',
          `Unknown ftp action "${action}" (upload, download, list, delete, exists)`,
        );
    }
  } catch (err) {
    if (err instanceof StepError) throw err;
    const msg = (err as Error).message ?? String(err);
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Timeout|connect/i.test(msg))
      throw new StepError('network', `${where}: ${msg}`);
    if (/530|auth|password|permission denied/i.test(msg))
      throw new StepError('invalid_params', `${where}: ${msg}`);
    if (/550|No such file|not found/i.test(msg)) throw new StepError('assertion', `${where}: ${msg}`);
    throw new StepError('unknown', `${where}: ${msg}`);
  } finally {
    await remote?.close().catch(() => {});
  }
}
