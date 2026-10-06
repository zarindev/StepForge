import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main } from '../src/cli.ts';

const BIN = resolve(import.meta.dirname, '../bin/stepforge.mjs');
let target: Server;
let dir = '';
let dataDir = '';
let base = '';

/** Runs the CLI in-process and captures its output. */
async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, '--data-dir', dataDir], {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const step = (method: string, url: string, status: number) => ({
  type: 'api.request',
  params: { method, url },
  assertions: [{ target: 'status', operator: 'equals', expected: status }],
});
const exportFile = () => ({
  format: 'stepforge.application',
  version: 1,
  exportedAt: '2026-10-07T00:00:00.000Z',
  application: { name: 'ShopDesk', slug: 'shopdesk', description: 'Orders', tags: [] },
  environments: [
    { name: 'Staging', baseUrl: base, variables: { SHOP: 'main' }, secretKeys: ['ADMIN_PASSWORD'] },
  ],
  tags: [{ name: 'smoke', color: '#22C55E' }],
  modules: [
    { ref: 'm1', parentRef: null, name: 'Catalogue' },
    { ref: 'm2', parentRef: 'm1', name: 'Checkout' },
  ],
  blocks: [{ ref: 'b1', name: 'Ping', steps: [step('GET', '/api/health', 200)] }],
  scenarios: [
    {
      ref: 's1',
      moduleRef: 'm1',
      name: 'Catalogue loads',
      priority: 'P1',
      tags: ['smoke'],
      steps: [step('GET', '/api/health', 200), { type: 'util.useBlock', params: { blockId: 'b1' } }],
      testCases: [{ code: 'TC-CAT-001', title: 'Default catalogue', expectedResult: '200' }],
    },
    {
      ref: 's2',
      moduleRef: 'm2',
      name: 'Place an order',
      priority: 'P1',
      // Calls a scenario that comes later in the file.
      steps: [{ type: 'util.callScenario', params: { scenarioId: 's3' } }, step('POST', '/api/orders', 201)],
    },
    { ref: 's3', moduleRef: 'm2', name: 'Cart is ready', steps: [step('GET', '/api/health', 200)] },
  ],
});

beforeAll(async () => {
  target = createServer((req, res) => {
    if (req.url === '/api/health') return void res.writeHead(200).end('{"ok":true}');
    if (req.url === '/api/orders') return void res.writeHead(500).end('{"message":"boom"}'); // the bug
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'sf-cli-'));
  dataDir = join(dir, 'data');
  writeFileSync(join(dir, 'shopdesk.json'), JSON.stringify(exportFile()));
});
afterAll(() => target.close());

describe('stepforge CLI', () => {
  it('prints help and rejects bad usage with exit code 2', async () => {
    const help = await cli('--help');
    expect(help.code).toBe(EXIT.passed);
    expect(help.out).toContain('StepForge by Md Zarin Tasnim');
    expect((await main([], { out: () => {}, err: () => {} })).valueOf()).toBe(EXIT.error);
    const unknown = await cli('deploy');
    expect(unknown).toMatchObject({
      code: EXIT.error,
      err: expect.stringContaining('Unknown command "deploy"'),
    });
    expect((await cli('run', '--nope')).code).toBe(EXIT.error);
    expect(await cli('run', '--env', 'Staging')).toMatchObject({
      code: EXIT.error,
      err: 'Error: --app is required',
    });
  });

  it('imports an application export (ids remapped, secrets listed, not copied)', async () => {
    const r = await cli('import', '--file', join(dir, 'shopdesk.json'));
    expect(r.code).toBe(EXIT.passed);
    expect(r.out).toContain(
      'Imported "shopdesk": 1 environments, 2 modules, 3 scenarios, 1 test cases, 1 blocks',
    );
    expect(r.out).toContain('Enter these secrets again in Staging: ADMIN_PASSWORD');
    const again = await cli('import', '--file', join(dir, 'shopdesk.json'));
    expect(again).toMatchObject({ code: EXIT.error, err: expect.stringContaining('already exists') });
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"format":"other"}');
    expect((await cli('import', '--file', bad)).err).toContain('Not a StepForge application export');

    const list = JSON.parse((await cli('list', '--json')).out) as {
      applications: {
        slug: string;
        environments: { name: string }[];
        modules: string[];
        tags: string[];
        scenarios: number;
      }[];
    };
    expect(list.applications[0]).toMatchObject({
      slug: 'shopdesk',
      environments: [{ name: 'Staging' }],
      modules: ['Catalogue', 'Checkout'],
      tags: ['smoke'],
      scenarios: 3,
    });
  });

  it('runs tests, writes JUnit and HTML, and exits 1 when a test fails', async () => {
    const junit = join(dir, 'out/results.xml');
    const html = join(dir, 'out/report.html');
    const r = await cli('run', '--app', 'shopdesk', '--env', 'staging', '--junit', junit, '--html', html);
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toMatch(/Running ShopDesk · Staging \(3 tests, run \w+\)/);
    expect(r.out).toContain('✓ Catalogue loads');
    expect(r.out).toContain('✗ Place an order');
    expect(r.out).toContain('FAILED: 2/3 passed, 1 failed');
    expect(r.out).toContain(`Wrote ${junit}`);
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('<testsuites name="StepForge · ShopDesk" tests="3" failures="1"');
    expect(xml).toContain('classname="ShopDesk.Catalogue.Checkout"');
    expect(readFileSync(html, 'utf8')).toContain('Md Zarin Tasnim');
  }, 60_000);

  it('runs only a tag or named scenarios, and exits 0 when they pass', async () => {
    const tagged = await cli('run', '--app', 'shopdesk', '--env', 'Staging', '--tag', 'smoke', '--json');
    expect(tagged.code).toBe(EXIT.passed);
    const j = JSON.parse(tagged.out) as { status: string; totals: { total: number }; exitCode: number };
    expect(j).toMatchObject({ status: 'passed', totals: { total: 1 }, exitCode: 0 });
    const named = await cli('run', '--app', 'shopdesk', '--env', 'Staging', '--scenario', 'Cart is ready');
    expect(named.code).toBe(EXIT.passed);
    expect(named.out).toContain('PASSED: 1/1 passed');
    expect((await cli('run', '--app', 'shopdesk', '--env', 'Prod')).err).toContain(
      'No environment "Prod" in ShopDesk. Known: Staging',
    );
    expect(
      (await cli('run', '--app', 'shopdesk', '--env', 'Staging', '--tag', 'x', '--module', 'y')).code,
    ).toBe(EXIT.error);
  }, 60_000);

  it('stores a secret from an environment variable, never from an argument', async () => {
    process.env.SF_TEST_ADMIN_PASSWORD = 's3cret-Value!';
    const r = await cli(
      'secret',
      'set',
      '--app',
      'shopdesk',
      '--env',
      'Staging',
      '--key',
      'ADMIN_PASSWORD',
      '--from-env',
      'SF_TEST_ADMIN_PASSWORD',
    );
    delete process.env.SF_TEST_ADMIN_PASSWORD;
    expect(r).toMatchObject({
      code: EXIT.passed,
      out: 'Stored secret ADMIN_PASSWORD in ShopDesk · Staging (encrypted)',
    });
    const db = new Database(join(dataDir, 'stepforge.db'), { readonly: true });
    const rows = JSON.stringify(db.prepare("select * from secrets where key = 'ADMIN_PASSWORD'").all());
    db.close();
    expect(rows).toContain('ADMIN_PASSWORD');
    expect(rows).not.toContain('s3cret-Value!');
    expect(
      (await cli('secret', 'set', '--app', 'shopdesk', '--env', 'Staging', '--key', 'X', '--value', 'oops'))
        .code,
    ).toBe(EXIT.error);
    expect((await cli('secret', 'remove')).code).toBe(EXIT.error);
  });

  it('writes a report for an earlier run and round-trips an export', async () => {
    const last = JSON.parse(
      (await cli('run', '--app', 'shopdesk', '--env', 'Staging', '--module', 'Checkout', '--json')).out,
    ) as { runId: string; status: string };
    expect(last.status).toBe('failed');
    const out = join(dir, 'out/run.xml');
    const r = await cli('report', '--run', last.runId, '--format', 'junit', '--out', out);
    expect(r.code).toBe(EXIT.passed);
    // The nested call reaches the planted bug through the remapped scenario id, not a missing one.
    const xml = readFileSync(out, 'utf8');
    expect(xml).toContain('tests="2"');
    expect(xml).not.toContain('Cannot load scenario');

    const exported = join(dir, 'out/shopdesk-export.json');
    expect((await cli('export', '--app', 'shopdesk', '--out', exported)).out).toContain(
      'secrets not included',
    );
    const e = JSON.parse(readFileSync(exported, 'utf8'));
    expect(e.environments[0]).toMatchObject({ name: 'Staging', variables: { SHOP: 'main' } });
    expect(e.generator).toContain('Md Zarin Tasnim');
    const copy = await cli('import', '--file', exported, '--slug', 'shopdesk-copy');
    expect(copy.out).toContain(
      'Imported "shopdesk-copy": 1 environments, 2 modules, 3 scenarios, 1 test cases, 1 blocks',
    );
    const again = await cli('run', '--app', 'shopdesk-copy', '--env', 'Staging', '--json');
    expect(JSON.parse(again.out).totals).toMatchObject({ total: 3, passed: 2, failed: 1 });
  }, 60_000);

  it('exports code into a folder', async () => {
    const list = await cli('codegen', '--list');
    expect(list.out).toContain('playwright-ts    Playwright Test (TypeScript) · --pom');
    const out = join(dir, 'export-pw');
    const r = await cli(
      'codegen',
      '--app',
      'shopdesk',
      '--target',
      'playwright-ts',
      '--module',
      'Checkout',
      '--out',
      out,
      '--pom',
    );
    expect(r.code).toBe(EXIT.passed);
    expect(r.out).toContain(`Wrote `);
    expect(existsSync(join(out, 'tests/catalogue/checkout/place-an-order.spec.ts'))).toBe(true);
    expect(existsSync(join(out, 'tests/catalogue/catalogue-loads.spec.ts'))).toBe(false); // other module
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain(
      'Generated by StepForge — by Md Zarin Tasnim',
    );
    expect((await cli('codegen', '--app', 'shopdesk', '--target', 'robot', '--out', out)).err).toContain(
      'Unknown target "robot"',
    );
  });

  it('does not interrupt runs of a StepForge server that is open on the same data folder', async () => {
    const db = new Database(join(dataDir, 'stepforge.db'));
    const app = db.prepare("select id from applications where slug = 'shopdesk'").get() as { id: string };
    db.prepare(
      "insert into runs (id, application_id, status, trigger, scope_json, options_json, totals_json, created_at, updated_at) values ('LIVE', ?, 'running', 'manual', '{}', '{}', '{}', datetime('now'), datetime('now'))",
    ).run(app.id);
    expect((await cli('list')).code).toBe(EXIT.passed);
    expect((db.prepare("select status from runs where id = 'LIVE'").get() as { status: string }).status).toBe(
      'running',
    );
    db.prepare("delete from runs where id = 'LIVE'").run();
    db.close();
  });

  it('works as an installed command (bin shim) with real exit codes', async () => {
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [BIN, '--version']);
    expect(stdout.trim()).toBe('0.1.0');
    const failed = await run(process.execPath, [
      BIN,
      'run',
      '--app',
      'shopdesk',
      '--env',
      'Staging',
      '--data-dir',
      dataDir,
    ]).catch((e: { code: number; stdout: string }) => e);
    expect((failed as { code: number }).code).toBe(1);
    expect(existsSync(join(dataDir, 'stepforge.db'))).toBe(true);
  }, 60_000);
});
