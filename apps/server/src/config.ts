import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments, existing env wins. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1] || line.trimStart().startsWith('#')) continue;
    const value = m[2]?.replace(/^(['"])(.*)\1$/, '$2') ?? '';
    process.env[m[1]] ??= value;
  }
}

export type ServerConfig = {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  dbFile: string;
  keyFile: string;
  artifactsDir: string;
  webDist: string;
  logLevel: string;
  openBrowser: boolean;
};

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  loadDotEnv(join(REPO_ROOT, '.env'));
  const rawData = process.env.STEPFORGE_DATA_DIR ?? './data';
  const dataDir = overrides.dataDir ?? (isAbsolute(rawData) ? rawData : resolve(REPO_ROOT, rawData));
  const port = Number(process.env.STEPFORGE_PORT ?? 4400);
  return {
    host: '127.0.0.1',
    port: Number.isInteger(port) && port > 0 ? port : 4400,
    dataDir,
    dbFile: join(dataDir, 'stepforge.db'),
    keyFile: join(dataDir, '.key'),
    artifactsDir: join(dataDir, 'artifacts'),
    webDist: join(REPO_ROOT, 'apps/web/dist'),
    logLevel: process.env.STEPFORGE_LOG_LEVEL ?? 'info',
    openBrowser: (process.env.STEPFORGE_OPEN_BROWSER ?? '1') !== '0',
    ...overrides,
  };
}
