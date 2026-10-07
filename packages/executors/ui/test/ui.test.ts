import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool, createUiExecutor } from '../src/index.ts';

const html = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
let server: Server;
let baseUrl = '';
const pool = new BrowserPool();

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/login') return res.writeHead(500).end('{"error":"db down"}');
    if (req.url === '/covered.html')
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<button data-testid="go">Go</button><div class="sheet" style="position:fixed;inset:0;z-index:9">Rate us</div>',
        );
    if (req.url === '/other.html')
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Help</title><h1>Help page</h1>');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await pool.closeAll();
  server.close();
});

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (s: ReturnType<typeof steps>, opts: Partial<typeof DEFAULT_RUN_OPTIONS> = {}) => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sf-ui-'));
  return runTestCase({
    runId: 'R',
    steps: s,
    data: { email: 'ana@clinic.test' },
    env: { baseUrl },
    executors: [createUiExecutor(pool), utilExecutor],
    options: {
      ...DEFAULT_RUN_OPTIONS,
      defaultTimeoutMs: 4000,
      video: 'off',
      trace: 'off',
      screenshots: 'off',
      baseUrl,
      ...opts,
    },
    artifactsDir,
  }).then((r) => ({ ...r, artifactsDir }));
};

describe('UI executor', () => {
  it('logs in with label/testId/role locators, select, check and waits for async text', async () => {
    const r = await run(
      steps(
        {
          type: 'ui.navigate',
          params: { url: '/' },
          assertions: [{ target: 'title', operator: 'equals', expected: 'Fixture Login' }],
        },
        {
          type: 'ui.fill',
          params: { value: '{{data.email}}' },
          locators: [{ strategy: 'label', value: 'Email' }],
        },
        {
          type: 'ui.fill',
          params: { value: 'secret' },
          locators: [{ strategy: 'label', value: 'Password' }],
        },
        { type: 'ui.check', locators: [{ strategy: 'label', value: 'Remember me' }] },
        {
          type: 'ui.select',
          params: { label: 'Doctor' },
          locators: [{ strategy: 'role', value: 'combobox', name: 'Role' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'login-btn' }] },
        {
          type: 'ui.assert',
          params: { check: 'textContains', expected: 'Welcome ana@clinic.test (doctor)' },
          locators: [{ strategy: 'role', value: 'status' }],
        },
        {
          type: 'ui.extract',
          params: { from: 'text', regex: 'Welcome (\\S+)' },
          locators: [{ strategy: 'css', value: '#msg' }],
          captureAs: 'who',
        },
      ),
    );
    expect(
      r.steps.map((s) => `${s.type}:${s.status}${s.message && s.status !== 'passed' ? ` ${s.message}` : ''}`),
    ).toEqual(r.steps.map((s) => `${s.type}:passed`));
    expect(r.vars.who).toBe('ana@clinic.test');
  });

  it('heals a broken primary locator with the next strategy', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        {
          type: 'ui.click',
          locators: [
            { strategy: 'testId', value: 'old-login-button' },
            { strategy: 'role', value: 'button', name: 'Sign in' },
          ],
        },
      ),
    );
    expect(r.status).toBe('passed');
    expect(r.steps[1]!.healedLocator).toEqual({
      from: { strategy: 'testId', value: 'old-login-button' },
      to: { strategy: 'role', value: 'button', name: 'Sign in' },
    });
  });

  it('handles dialogs, new tabs and iframes', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        { type: 'ui.handleDialog', params: { action: 'accept' } },
        { type: 'ui.click', locators: [{ strategy: 'text', value: 'Delete record' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Deleted' },
          locators: [{ strategy: 'css', value: '#msg' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'text', value: 'Delete record' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Kept' },
          locators: [{ strategy: 'css', value: '#msg' }],
        },
        { type: 'ui.switchFrame', params: { selector: '#frm' } },
        { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Frame button' }] },
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'text', value: 'Clicked in frame' }],
        },
        { type: 'ui.switchFrame', params: { main: true } },
        { type: 'ui.click', locators: [{ strategy: 'role', value: 'link', name: 'Open help' }] },
        { type: 'ui.switchTab', params: { urlContains: 'other.html' } },
        { type: 'ui.assert', params: { check: 'title', expected: 'Help' } },
        { type: 'ui.closeTab' },
        { type: 'ui.assert', params: { check: 'title', expected: 'Fixture Login' } },
      ),
    );
    expect(r.steps.filter((s) => s.status !== 'passed').map((s) => `${s.position}:${s.message}`)).toEqual([]);
  });

  it('fails clearly and keeps evidence: screenshot, DOM, console, network, video, trace', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        { type: 'ui.click', locators: [{ strategy: 'css', value: '#boom' }] },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'login-btn' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Welcome back' },
          locators: [{ strategy: 'css', value: '#msg' }],
          timeoutMs: 1500,
        },
      ),
      { video: 'onFailure', trace: 'onFailure', screenshots: 'everyStep' },
    );
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('assertion');
    expect(r.error).toMatch(/Expected text "Welcome back", but got "Welcome/);
    expect(r.steps[0]!.screenshotPath).toMatch(/step-01\.jpg$/);
    expect(r.steps[3]!.screenshotPath).toMatch(/step-04-failed\.png$/);
    const kinds = r.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['console', 'dom', 'network', 'trace', 'video']);
    for (const a of r.artifacts) expect(existsSync(a.path)).toBe(true);
    const consoleLog = JSON.parse(readFileSync(join(r.artifactsDir, 'console.json'), 'utf8'));
    expect(consoleLog.some((c: { type: string }) => c.type === 'pageerror')).toBe(true);
    const network = JSON.parse(readFileSync(join(r.artifactsDir, 'network.json'), 'utf8'));
    expect(
      network.some((n: { url: string; status: number }) => n.url.endsWith('/api/login') && n.status === 500),
    ).toBe(true);
  }, 30_000);

  it('discards video and trace for passing tests in onFailure mode', async () => {
    const r = await run(steps({ type: 'ui.navigate', params: { url: '/' } }), {
      video: 'onFailure',
      trace: 'onFailure',
    });
    expect(r.status).toBe('passed');
    expect(r.artifacts.map((a) => a.kind).sort()).toEqual(['console', 'network']);
    expect(existsSync(join(r.artifactsDir, 'video.webm'))).toBe(false);
  });

  it('reports a missing element with every strategy tried', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        {
          type: 'ui.click',
          locators: [
            { strategy: 'testId', value: 'nope' },
            { strategy: 'text', value: 'Nope' },
          ],
          timeoutMs: 600,
        },
      ),
    );
    expect(r.errorKind).toBe('element_not_found');
    expect(r.error).toContain('testId=nope | text=Nope');
  });

  it('says which element covers the one it could not click', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/covered.html' } },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'go' }], timeoutMs: 1200 },
      ),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/<div class="sheet"[^>]*>Rate us<\/div> intercepts pointer events/);
  });
});
