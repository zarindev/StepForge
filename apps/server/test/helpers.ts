import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import type { ServerConfig } from '../src/config.ts';

export const TOKEN = 'test-token-123';
export const H = { host: '127.0.0.1:4400', 'x-stepforge-token': TOKEN };

/** Builds a server on an in-memory database with a throwaway data folder. */
export async function testServer(extra: Partial<ServerConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-server-'));
  return buildApp({
    token: TOKEN,
    config: {
      dataDir,
      dbFile: ':memory:',
      artifactsDir: join(dataDir, 'a'),
      keyFile: join(dataDir, '.key'),
      webDist: join(dataDir, 'no-web'),
      ...extra,
    },
  });
}
