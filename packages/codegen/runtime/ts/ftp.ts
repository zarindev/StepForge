// FTP, FTPS and SFTP for tests exported by StepForge (by Md Zarin Tasnim), with basic-ftp and ssh2-sftp-client.
import { Client as FtpClient } from 'basic-ftp';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import SftpClient from 'ssh2-sftp-client';

export type FtpOptions = {
  protocol?: 'ftp' | 'ftps' | 'sftp';
  host: string;
  port?: number | string;
  username?: string;
  password?: string;
  /** SFTP: a private key file instead of the password. */
  privateKey?: string;
  action: 'upload' | 'download' | 'list' | 'delete' | 'exists';
  remotePath?: string;
  localPath?: string;
  /** upload: this text instead of a local file. */
  content?: string;
  timeoutMs?: number;
};

/** What a step can check: download content, size, path; list count, names; exists. */
export type FtpResult = {
  content?: string;
  size?: number;
  path?: string;
  count?: number;
  names?: string[];
  exists?: boolean;
  entries?: { name: string; size: number; type: string }[];
};

type Remote = {
  upload(from: Buffer | string, to: string): Promise<void>;
  download(from: string, to: string): Promise<void>;
  list(dir: string): Promise<{ name: string; size: number; type: string }[]>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  close(): Promise<void>;
};

async function connect(o: FtpOptions): Promise<Remote> {
  const timeout = o.timeoutMs ?? 15_000;
  const user = o.username ?? 'anonymous';
  if (o.protocol === 'sftp') {
    const sftp = new SftpClient();
    await sftp.connect({
      host: o.host,
      port: Number(o.port || 22),
      username: user,
      ...(o.privateKey ? { privateKey: readFileSync(o.privateKey) } : { password: o.password ?? '' }),
      readyTimeout: timeout,
    });
    return {
      upload: async (from, to) => void (await sftp.put(from, to)),
      download: async (from, to) => writeFileSync(to, (await sftp.get(from)) as Buffer),
      list: async (dir) =>
        (await sftp.list(dir)).map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type === 'd' ? 'directory' : f.type === '-' ? 'file' : 'other',
        })),
      remove: async (path) => void (await sftp.delete(path)),
      exists: async (path) => (await sftp.exists(path)) !== false,
      close: async () => void (await sftp.end()),
    };
  }
  const ftp = new FtpClient(timeout);
  await ftp.access({
    host: o.host,
    port: Number(o.port || 21),
    user,
    password: o.password ?? '',
    secure: o.protocol === 'ftps',
    // Test servers often use self-signed certificates.
    secureOptions: { rejectUnauthorized: false },
  });
  return {
    upload: async (from, to) =>
      void (await ftp.uploadFrom(typeof from === 'string' ? from : Readable.from(from), to)),
    download: async (from, to) => void (await ftp.downloadTo(to, from)),
    list: async (dir) =>
      (await ftp.list(dir)).map((f) => ({
        name: f.name,
        size: f.size,
        type: f.isDirectory ? 'directory' : f.isFile ? 'file' : 'other',
      })),
    remove: async (path) => void (await ftp.remove(path)),
    exists: async (path) => {
      // Listed in its parent folder; a missing parent means it does not exist.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.';
      try {
        return (await ftp.list(dir)).some((f) => f.name === basename(path));
      } catch (err) {
        if (/550|No such file|not found|cannot find/i.test((err as Error).message ?? '')) return false;
        throw err;
      }
    },
    close: async () => ftp.close(),
  };
}

/** Upload (a local file, or `content` as text), download (its text can be checked), list, delete, exists. */
export async function ftp(o: FtpOptions): Promise<FtpResult> {
  const remotePath = o.remotePath ?? (o.action === 'list' ? '.' : '');
  if (!remotePath) throw new Error(`ftp ${o.action} needs a remotePath`);
  const remote = await connect(o);
  try {
    switch (o.action) {
      case 'upload': {
        const from =
          o.content !== undefined && o.content !== ''
            ? Buffer.from(String(o.content))
            : String(o.localPath ?? '');
        if (from === '') throw new Error('ftp upload needs localPath or content');
        await remote.upload(from, remotePath);
        return { path: remotePath, size: typeof from === 'string' ? statSync(from).size : from.length };
      }
      case 'download': {
        const to = o.localPath || join(mkdtempSync(join(tmpdir(), 'ftp-')), basename(remotePath));
        await remote.download(remotePath, to);
        const size = statSync(to).size;
        return { path: to, size, content: size <= 5_000_000 ? readFileSync(to, 'utf8') : '' };
      }
      case 'list': {
        const entries = await remote.list(remotePath);
        return { entries, count: entries.length, names: entries.map((e) => e.name) };
      }
      case 'delete':
        await remote.remove(remotePath);
        return {};
      default: {
        // "dir/" is "dir"; the root (and the login folder) always exist.
        const path = remotePath.replace(/\/+$/, '');
        return { exists: path === '' || path === '.' ? true : await remote.exists(path) };
      }
    }
  } finally {
    await remote.close().catch(() => {});
  }
}
