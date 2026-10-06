import ExcelJS from 'exceljs';
import { transformSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  generate,
  TARGETS,
  zipProject,
  type GeneratedProject,
  type TargetId,
} from '../src/index.ts';
import { camel, envName, parseString, snake, val } from '../src/values.ts';
import { KITCHEN_SINK, PLANTED_SECRET } from './fixtures.ts';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['--version']).status === 0;

const RUNTIME =
  /(^|\/)support\/(helpers|api|db|mail|tabs|browser)\.(ts|py)$|find\.js$|support\/(Checks|J|Api|Fake|Db|Mail|Browser)\.java$|cypress\/support\/(helpers|mail)\.js$|cypress\/plugins\/.*\.cjs$/;

/** Snapshot of every generated text file (one file per output file, readable in review). */
async function snapshot(target: TargetId, project: GeneratedProject, variant = '') {
  const listing: string[] = [];
  for (const [path, content] of Object.entries(project.files).sort(([a], [b]) => a.localeCompare(b))) {
    listing.push(
      `${path} (${typeof content === 'string' ? `${content.split('\n').length} lines` : 'binary'})`,
    );
    // Runtime helpers are copied verbatim from packages/codegen/runtime (tested there); only generated code is snapshotted.
    if (typeof content === 'string' && !RUNTIME.test(path))
      await expect(content).toMatchFileSnapshot(`__snapshots__/${target}${variant}/${path}.snap`);
  }
  listing.push(
    '',
    'Warnings:',
    ...project.warnings.map((w) => `- ${w.scenario ?? ''} | ${w.step ?? ''} | ${w.message}`),
  );
  await expect(`${listing.join('\n')}\n`).toMatchFileSnapshot(
    `__snapshots__/${target}${variant}/_files.snap`,
  );
}

describe('values', () => {
  it('parses placeholders into references and keeps whole-placeholder types', () => {
    expect(parseString('Hi {{data.name}}, run {{run.id}}!')).toEqual({
      t: 'str',
      parts: ['Hi ', { scope: 'data', name: 'name' }, ', run ', { scope: 'run', name: 'id' }, '!'],
    });
    expect(val('{{vars.count}}')).toEqual({ t: 'ref', ref: { scope: 'vars', name: 'count' } });
    expect(val('{{env.baseUrl}}/x')).toEqual({
      t: 'str',
      parts: [{ scope: 'baseUrl', name: 'baseUrl' }, '/x'],
    });
    expect(val('{{unknown.x}} stays')).toEqual({ t: 'str', parts: ['{{unknown.x}} stays'] });
  });

  it('names things for each language', () => {
    expect(camel('Sign in — admin')).toBe('signInAdmin');
    expect(snake('Checkout flow 2')).toBe('checkout_flow_2');
    expect(envName('apiToken')).toBe('API_TOKEN');
    expect(envName('api-version')).toBe('API_VERSION');
    expect(camel('2FA code')).toBe('_2FaCode');
  });
});

describe('plan', () => {
  it('inlines blocks and called scenarios, collects secrets and variables, and reports what cannot be exported', () => {
    const plan = buildPlan(KITCHEN_SINK, { pom: true });
    expect(plan.secrets).toEqual(['adminPassword', 'apiToken']);
    expect(plan.variables).toEqual(['api-version', 'region']);
    const s1 = plan.tests[0]!;
    expect(
      s1.ops
        .filter((o) => o.op === 'comment')
        .map((o) => (o as { text: string }).text)
        .slice(0, 3),
    ).toEqual(['Block: Sign in as admin', 'Open /login', 'Type "{{data.user}}" into the "Email" field']);
    expect(s1.ops.some((o) => o.op === 'goto' && JSON.stringify(o.url).includes('/cart'))).toBe(true); // called scenario
    const messages = plan.warnings.map((w) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'visual checkpoints are not exported; add a screenshot comparison in the target framework',
        'auth type "oauth2" is not exported; set the header yourself',
        'the JSON Schema check on "$" is not exported',
        'MongoDB steps are not exported; use the MongoDB driver of the target language',
        'SQL Server helpers are not generated; the SQL file is exported for reference',
        'the data-quality audit runs only in StepForge',
        'IMAP inboxes are not exported; the helper reads a Mailpit server (MAILPIT_URL)',
        'performance measurements run only in StepForge',
        'load tests are not part of functional tests; export the scenario to k6 instead',
        expect.stringContaining('the "unknown" connection is not set up'),
      ]),
    );
    // Page objects: grouped by page, steps after a tab switch or inside a frame stay inline.
    expect([...plan.pages.keys()]).toEqual(['Login', 'Products']);
    expect(plan.pages.get('Login')!.elements.map((e) => e.name)).toEqual([
      'emailField',
      'passwordField',
      'signInButton',
    ]);
  });
});

const ALL = TARGETS.map((t) => t.id);

describe.each(ALL)('%s', (target) => {
  it('matches the snapshot, is valid code, and never contains a secret value', async () => {
    const project = await generate(KITCHEN_SINK, { target, pom: false, ci: ['github', 'gitlab'] });
    expect(Object.keys(project.files).length).toBeGreaterThan(0);
    for (const [path, content] of Object.entries(project.files)) {
      const text = typeof content === 'string' ? content : content.toString('latin1');
      expect(text, path).not.toContain(PLANTED_SECRET);
      if (typeof content !== 'string') continue;
      if (/\.(ts|js|cjs|mjs)$/.test(path) && !path.endsWith('find.js'))
        expect(
          () => transformSync(content, { loader: path.endsWith('.ts') ? 'ts' : 'js', format: 'esm' }),
          path,
        ).not.toThrow();
      if (path.endsWith('.json')) expect(() => JSON.parse(content), path).not.toThrow();
    }
    if (target !== 'docs-xlsx') await snapshot(target, project);
  });
});

describe('page objects', () => {
  it.each(['playwright-ts', 'playwright-py', 'cypress-js', 'selenium-py', 'selenium-java'] as TargetId[])(
    '%s',
    async (target) => {
      const project = await generate(KITCHEN_SINK, { target, pom: true });
      await snapshot(target, project, '-pom');
    },
  );
});

describe.skipIf(!hasPython)('generated Python compiles', () => {
  it.each(['playwright-py', 'selenium-py', 'pytest-requests'] as TargetId[])('%s', async (target) => {
    for (const pom of [false, true]) {
      const project = await generate(KITCHEN_SINK, { target, pom });
      const dir = mkdtempSync(join(tmpdir(), `sf-py-${target}-`));
      const py: string[] = [];
      for (const [path, content] of Object.entries(project.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
        if (path.endsWith('.py')) py.push(join(dir, path));
      }
      expect(() => execFileSync('python3', ['-m', 'py_compile', ...py], { stdio: 'pipe' })).not.toThrow();
    }
  });
});

describe.skipIf(!hasBash)('generated shell script', () => {
  it('passes bash -n', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'curl' });
    const dir = mkdtempSync(join(tmpdir(), 'sf-sh-'));
    writeFileSync(join(dir, 'requests.sh'), project.files['requests.sh']!);
    expect(() => execFileSync('bash', ['-n', join(dir, 'requests.sh')], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('Excel test cases and zip', () => {
  it('writes one row per test case with plain-English steps and the author', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'docs-xlsx' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(project.files['shopdesk-test-cases.xlsx'] as never);
    const ws = wb.getWorksheet('Test cases')!;
    expect(ws.rowCount).toBe(1 + 2 + 1 + 1);
    expect(ws.getRow(2).getCell(1).value).toBe('TC-CHE-001');
    expect(String(ws.getRow(2).getCell(8).value)).toContain('1. Do “Sign in as admin”:');
    expect(String(ws.getRow(2).getCell(9).value)).toBe('user = ana@shop.test; qty = 2');
    expect(wb.creator).toBe('Md Zarin Tasnim');
    expect(wb.getWorksheet('About')!.getRow(6).values).toEqual([
      undefined,
      'Generated by',
      'Generated by StepForge — by Md Zarin Tasnim',
    ]);
  });

  it('zips a project inside a folder', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'playwright-ts' });
    const zip = await JSZip.loadAsync(await zipProject(project, 'shopdesk-playwright'));
    expect(Object.keys(zip.files)).toContain('shopdesk-playwright/playwright.config.ts');
    expect(await zip.file('shopdesk-playwright/README.md')!.async('string')).toContain(
      'Generated by StepForge — by Md Zarin Tasnim',
    );
  });
});
