/**
 * Proves that exported code runs (Phase 12; StepForge by Md Zarin Tasnim). It starts CareClinic and Mailpit, imports
 * the CareClinic suite into a throwaway StepForge data folder, exports it, installs the exported project's own
 * dependencies and runs its tests against the demo app.
 *
 *   npx tsx scripts/verify-export.ts                          # Playwright (TypeScript) — what CI runs
 *   npx tsx scripts/verify-export.ts --targets all            # every runnable target whose tools are installed
 *   npx tsx scripts/verify-export.ts --targets cypress-js,selenium-py --pom
 *
 * Exits 1 if any exported project fails. Tools: Node (always), Python 3 (Python targets), Java 17 + Maven (Java),
 * k6, bash + curl + jq; a target whose tool is missing is reported as skipped, never as passed.
 */
import { MailpitServer, mailpitBinary } from '@stepforge/email';
import { buildApp } from '@stepforge/server';
import * as repo from '@stepforge/db/repos';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const PASSWORD = 'Reception123!'; // CareClinic's public demo password (demo data only)

const { values } = parseArgs({
  options: {
    targets: { type: 'string', default: 'playwright-ts' },
    pom: { type: 'boolean', default: false },
  },
});

type Runner = { tool: string[]; steps: (dir: string) => [string, string[]][] };
const venv = (dir: string) => join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
const RUNNERS: Record<string, Runner> = {
  'playwright-ts': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['playwright', 'install', 'chromium']],
      ['npx', ['playwright', 'test']],
    ],
  },
  'cypress-js': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['cypress', 'run']],
    ],
  },
  'playwright-py': {
    tool: ['python3'],
    steps: (d) => [
      ['python3', ['-m', 'venv', '.venv']],
      [join(venv(d), 'pip'), ['install', '-q', '-r', 'requirements.txt']],
      [join(venv(d), 'python'), ['-m', 'playwright', 'install', 'chromium']],
      [join(venv(d), 'python'), ['-m', 'pytest', '-q']],
    ],
  },
  'selenium-py': {
    tool: ['python3'],
    steps: (d) => [
      ['python3', ['-m', 'venv', '.venv']],
      [join(venv(d), 'pip'), ['install', '-q', '-r', 'requirements.txt']],
      [join(venv(d), 'python'), ['-m', 'pytest', '-q']],
    ],
  },
  'pytest-requests': {
    tool: ['python3'],
    steps: (d) => [
      ['python3', ['-m', 'venv', '.venv']],
      [join(venv(d), 'pip'), ['install', '-q', '-r', 'requirements.txt']],
      [join(venv(d), 'python'), ['-m', 'pytest', '-q']],
    ],
  },
  'selenium-java': { tool: ['mvn', 'java'], steps: () => [['mvn', ['-B', '-q', 'test']]] },
  'rest-assured': { tool: ['mvn', 'java'], steps: () => [['mvn', ['-B', '-q', 'test']]] },
  k6: { tool: ['k6'], steps: () => [['k6', ['run', '-q', '-e', `PASSWORD=${PASSWORD}`, 'script.js']]] },
  curl: { tool: ['bash', 'curl', 'jq'], steps: () => [['bash', ['requests.sh']]] },
  postman: {
    tool: ['npx'],
    steps: () => [
      [
        'npx',
        [
          '-y',
          'newman@6',
          'run',
          'careclinic.postman_collection.json',
          '--env-var',
          `password=${PASSWORD}`,
          '--env-var',
          'baseUrl=__BASE_URL__',
        ],
      ],
    ],
  },
};

const has = (cmd: string) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

async function waitFor(url: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (
      await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

async function main() {
  const targets =
    values.targets === 'all' ? Object.keys(RUNNERS) : values.targets!.split(',').map((t) => t.trim());
  for (const t of targets)
    if (!RUNNERS[t]) throw new Error(`No runner for "${t}" (known: ${Object.keys(RUNNERS).join(', ')})`);
  const work = mkdtempSync(join(tmpdir(), 'stepforge-verify-export-'));
  console.log(`Work folder: ${work}`);

  // Mailpit (the sign-up scenario reads its verification code from email) and CareClinic.
  const binDir = process.env.STEPFORGE_BIN_DIR
    ? resolve(ROOT, process.env.STEPFORGE_BIN_DIR)
    : join(ROOT, 'data/bin');
  const mailpit = new MailpitServer({
    binDir,
    dataDir: join(work, 'mailpit'),
    httpPort: await freePort(),
    smtpPort: await freePort(),
  });
  if (!existsSync(mailpitBinary(binDir))) throw new Error('Mailpit is missing: run npm run mailpit:install');
  await mailpit.start();
  const clinicPort = await freePort();
  const clinicDb = join(work, 'clinic.db');
  const clinic = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'demo/clinic-app/src/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLINIC_PORT: String(clinicPort),
      CLINIC_DB: clinicDb,
      CLINIC_SMTP_PORT: String(mailpit.smtpPort),
    },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${clinicPort}`;
  const results: { target: string; result: 'passed' | 'failed' | 'skipped'; note?: string }[] = [];
  try {
    await waitFor(`${baseUrl}/api/health`);

    // A throwaway StepForge with the CareClinic suite and its secret.
    const { app, ctx } = await buildApp({
      embedded: true,
      config: { dataDir: join(work, 'stepforge'), port: 0 },
    });
    const suite = JSON.parse(
      readFileSync(join(ROOT, 'demo/clinic-app/stepforge/codegen-suite.json'), 'utf8'),
    );
    const imported = repo.importApplication(ctx.db, suite);
    const env = repo.listEnvironments(ctx.db, imported.applicationId)[0]!;
    repo.updateEnvironment(ctx.db, env.id, { baseUrl });
    repo.setSecret(ctx.db, ctx.masterKey, env.id, { key: 'password', value: PASSWORD });

    const runEnv = {
      ...process.env,
      CI: process.env.CI ?? '1',
      BASE_URL: baseUrl,
      PASSWORD,
      DB_CLINIC_URL: `sqlite:${clinicDb}`,
      MAILPIT_URL: mailpit.url,
      ELECTRON_RUN_AS_NODE: undefined, // set by some editors; Cypress (Electron) must not inherit it
    };
    for (const target of targets) {
      const runner = RUNNERS[target]!;
      const missing = runner.tool.filter((t) => !has(t));
      if (missing.length) {
        results.push({ target, result: 'skipped', note: `${missing.join(', ')} not installed` });
        continue;
      }
      const { project } = await ctx.codegen.build(imported.applicationId, { target, pom: values.pom });
      const dir = join(work, target);
      for (const [path, content] of Object.entries(project.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      console.log(`\n━━ ${target}: ${Object.keys(project.files).length} files in ${dir}`);
      let code = 0;
      for (const [cmd, args] of runner.steps(dir)) {
        code = await run(
          cmd,
          args.map((a) => a.replace('__BASE_URL__', baseUrl)),
          dir,
          runEnv,
        );
        if (code !== 0) break;
      }
      results.push({ target, result: code === 0 ? 'passed' : 'failed' });
    }
    await app.close();
  } finally {
    clinic.kill();
    await mailpit.stop();
  }

  console.log('\nExported code against CareClinic:');
  for (const r of results)
    console.log(
      `  ${r.result === 'passed' ? '✓' : r.result === 'failed' ? '✗' : '-'} ${r.target.padEnd(16)} ${r.result}${r.note ? ` (${r.note})` : ''}`,
    );
  console.log(`Work folder (kept for inspection): ${work}`);
  process.exitCode =
    results.some((r) => r.result === 'failed') || !results.some((r) => r.result === 'passed') ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
