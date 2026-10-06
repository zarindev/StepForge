import { describe, expect, it } from 'vitest';
import {
  builtinRules,
  diagnose,
  matches,
  parseRules,
  render,
  type DiagnosisInput,
  type StepSnapshot,
} from '../src/index.ts';

const step = (s: Partial<StepSnapshot> & { type: string }): StepSnapshot => ({ status: 'failed', ...s });
const input = (failed: StepSnapshot, extra: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  failed,
  itemStatus: 'failed',
  ...extra,
});
const api = (status: number, expected: number | undefined, extra: Partial<StepSnapshot> = {}) =>
  step({
    type: 'api.request',
    errorKind: 'assertion',
    message: `Expected status equals ${expected}, but got ${status}`,
    request: { method: 'GET', url: 'http://127.0.0.1:8101/api/appointments' },
    response: { status, body: [] },
    assertions: expected
      ? [
          {
            target: 'status',
            operator: 'equals',
            expected,
            actual: status,
            passed: false,
            message: `Expected status equals ${expected}, but got ${status}`,
          },
        ]
      : [],
    ...extra,
  });

describe('rule format', () => {
  it('validates rules and names the broken one', () => {
    expect(() =>
      parseRules(
        '- id: Bad Id\n  category: x\n  confidence: 2\n  owner: app\n  when: {}\n  title: t\n  explanation: e\n  fix: f',
        'mine.yaml',
      ),
    ).toThrow(/mine\.yaml: rule Bad Id is invalid — id: .*confidence/);
    expect(builtinRules().length).toBeGreaterThan(45);
    expect(new Set(builtinRules().map((r) => r.id)).size).toBe(builtinRules().length);
  });

  it('matches with operators, any/all and renders templates with real values', () => {
    const facts = { status: 404, message: 'Timeout 15000ms exceeded', request: { url: '/api/x' }, list: [] };
    expect(matches({ status: [404, 410], message: { matches: 'timeout' } }, facts)).toBe(true);
    expect(matches({ status: { gte: 500 } }, facts)).toBe(false);
    expect(matches({ list: { exists: false }, missing: { exists: false } }, facts)).toBe(true);
    expect(matches({ any: [{ status: 500 }, { 'request.url': { contains: '/API/' } }] }, facts)).toBe(true);
    expect(matches({ status: { not: { in: [404] } } }, facts)).toBe(false);
    expect(render('{{request.url}} → {{status}} {{nope}}', facts)).toBe('/api/x → 404');
  });
});

describe('diagnoses (fixtures)', () => {
  it.each<[string, DiagnosisInput, string, string]>([
    // The planted CareClinic bugs, as their failing steps look in a run:
    ['missing auth check (CC-API-02 style)', input(api(200, 401)), 'missing_auth', 'app'],
    [
      '204 for an unknown id (CC-API-03 style)',
      input(api(204, 404, { request: { method: 'DELETE', url: '/api/patients/999999' } })),
      'wrong_status',
      'app',
    ],
    [
      'schema mismatch (CC-API-01 style)',
      input(
        step({
          type: 'api.request',
          errorKind: 'assertion',
          message: 'Contract violation (GET /api/doctors): /0/fee should be number',
          request: { method: 'GET', url: '/api/doctors' },
          response: { status: 200, body: [{ fee: '60.00' }] },
          assertions: [
            {
              target: 'contract',
              operator: 'matches',
              passed: false,
              message: 'Contract violation (GET /api/doctors): /0/fee should be number',
            },
          ],
        }),
      ),
      'schema_mismatch',
      'app',
    ],
    [
      'duplicate accepted (CC-DB-02 style)',
      input(api(201, 409, { request: { method: 'POST', url: '/api/patients' } })),
      'validation_missing',
      'app',
    ],
    [
      'orphan rows counted (CC-DB-01 style)',
      input(
        step({
          type: 'db.query',
          errorKind: 'assertion',
          message: 'Appointments of the deleted patient are still there',
          query: {
            connection: 'clinic',
            sql: 'SELECT COUNT(*) AS n FROM appointments WHERE patient_id = 1',
            rowCount: 1,
          },
          assertions: [
            {
              target: 'value',
              operator: 'equals',
              expected: 0,
              actual: 1,
              passed: false,
              message: 'Appointments of the deleted patient are still there',
            },
          ],
        }),
      ),
      'data_integrity',
      'app',
    ],
    // Other categories from the spec:
    ['500', input(api(500, 200)), 'wrong_status', 'app'],
    [
      '401 without expectation',
      input(api(401, undefined, { errorKind: 'assertion', message: 'x' })),
      'auth_required',
      'test',
    ],
    ['403', input(api(403, undefined)), 'forbidden', 'test'],
    ['404', input(api(404, undefined)), 'not_found', 'data'],
    ['409', input(api(409, undefined)), 'test_data_collision', 'data'],
    ['422', input(api(422, undefined)), 'invalid_request', 'test'],
    ['429', input(api(429, undefined)), 'rate_limited', 'environment'],
    ['503', input(api(503, undefined)), 'service_unavailable', 'environment'],
    [
      'server down',
      input(
        step({
          type: 'api.request',
          errorKind: 'network',
          message: 'connect ECONNREFUSED 127.0.0.1:8101',
          request: { method: 'GET', url: 'http://127.0.0.1:8101/api' },
        }),
      ),
      'network_unreachable',
      'environment',
    ],
    [
      'locator changed',
      input(
        step({
          type: 'ui.click',
          errorKind: 'element_not_found',
          message: 'No element matches testId=save-btn',
          locators: [{ strategy: 'testId', value: 'save-btn' }],
          diagnostics: {
            matchCount: 0,
            candidates: [
              {
                locator: { strategy: 'testId', value: 'save-patient' },
                text: 'Save patient',
                score: 0.8,
                count: 1,
              },
            ],
          },
        }),
      ),
      'locator_changed',
      'test',
    ],
    [
      'element covered',
      input(
        step({
          type: 'ui.click',
          errorKind: 'timeout',
          message: '<div class="modal"> intercepts pointer events',
        }),
      ),
      'element_covered',
      'test',
    ],
    [
      'element hidden',
      input(
        step({
          type: 'ui.click',
          errorKind: 'timeout',
          message: 'Timeout',
          diagnostics: { matchCount: 1, visible: false },
          locators: [{ strategy: 'testId', value: 'menu' }],
        }),
      ),
      'element_hidden',
      'app',
    ],
    [
      'navigation timeout',
      input(
        step({ type: 'ui.navigate', errorKind: 'timeout', message: 'page.goto: Timeout 15000ms exceeded' }),
      ),
      'navigation_timeout',
      'environment',
    ],
    [
      'slow API behind a timeout',
      input(step({ type: 'ui.assert', errorKind: 'timeout', message: 'Timeout', timeoutMs: 15000 }), {
        network: [
          {
            method: 'GET',
            url: 'http://x/api/report',
            status: 200,
            resourceType: 'fetch',
            durationMs: 14200,
          },
        ],
      }),
      'slow_api',
      'app',
    ],
    [
      'CORS',
      input(step({ type: 'ui.click', errorKind: 'element_not_found', message: 'x' }), {
        console: [{ type: 'error', text: "Access to fetch at 'http://api' has been blocked by CORS policy" }],
      }),
      'cors',
      'environment',
    ],
    [
      'offline',
      input(
        step({
          type: 'ui.navigate',
          errorKind: 'navigation',
          message: 'net::ERR_NAME_NOT_RESOLVED at http://nope.test',
        }),
      ),
      'network_unreachable',
      'environment',
    ],
    [
      'JS exception',
      input(step({ type: 'ui.assert', errorKind: 'assertion', message: 'Expected visible' }), {
        console: [
          {
            type: 'pageerror',
            text: "TypeError: Cannot read properties of undefined (reading 'total')",
            location: 'at render (http://x/app.js:42:7)',
          },
        ],
      }),
      'js_exception',
      'app',
    ],
    [
      'text mismatch',
      input(
        step({
          type: 'ui.assert',
          errorKind: 'assertion',
          message: 'Expected text',
          assertions: [
            {
              target: 'text',
              operator: 'equals',
              expected: 'Saved',
              actual: 'Error',
              passed: false,
              message: 'Expected text equals "Saved", but got "Error"',
            },
          ],
        }),
      ),
      'assertion_mismatch',
      'app',
    ],
    [
      'DB refused',
      input(
        step({
          type: 'db.query',
          errorKind: 'network',
          message: 'Cannot connect to PostgreSQL: ECONNREFUSED',
        }),
      ),
      'db_unreachable',
      'environment',
    ],
    [
      'DB constraint',
      input(
        step({ type: 'db.query', errorKind: 'assertion', message: 'UNIQUE constraint failed: customers.id' }),
      ),
      'db_constraint',
      'data',
    ],
    [
      'empty result',
      input(
        step({
          type: 'db.query',
          errorKind: 'assertion',
          message: 'x',
          query: { rowCount: 0 },
          assertions: [
            { target: 'rowCount', operator: 'equals', expected: 1, actual: 0, passed: false, message: 'x' },
          ],
        }),
      ),
      'empty_result',
      'data',
    ],
    [
      'email not received',
      input(
        step({
          type: 'email.waitForEmail',
          errorKind: 'timeout',
          message: 'No email to a@b.test arrived within 20 s',
        }),
      ),
      'email_not_received',
      'app',
    ],
    [
      'OTP not found',
      input(
        step({
          type: 'email.extractFromEmail',
          errorKind: 'assertion',
          message: 'Could not find a one-time code (4–8 digits …) in the email "Welcome"',
        }),
      ),
      'otp_not_found',
      'test',
    ],
    [
      'perf threshold',
      input(
        step({
          type: 'perf.loadTest',
          errorKind: 'assertion',
          message: 'p95',
          assertions: [
            {
              target: 'p95',
              operator: 'lt',
              expected: 800,
              actual: 912,
              passed: false,
              message: 'p95 latency 912 ms exceeded the threshold of 800 ms by 112 ms',
            },
          ],
        }),
      ),
      'perf_threshold',
      'app',
    ],
    [
      'flaky timing',
      input(step({ type: 'ui.click', errorKind: 'timeout', message: 'Timeout' }), {
        history: ['passed', 'failed', 'passed', 'passed'],
      }),
      'flaky_timing',
      'test',
    ],
    [
      'test configuration',
      input(
        step({ type: 'util.setVariable', errorKind: 'variable', message: 'Unknown variable {{vars.x}}' }),
      ),
      'test_configuration',
      'test',
    ],
    [
      'anything else',
      input(step({ type: 'util.log', errorKind: 'unknown', message: 'boom' })),
      'unknown',
      'test',
    ],
  ])('%s', (_name, i, category, owner) => {
    const d = diagnose(i);
    expect([d.category, d.owner]).toEqual([category, owner]);
    // Templates must not leak placeholders or "undefined" (unless the real error text contains them).
    const raw = `${i.failed.message ?? ''} ${JSON.stringify(i.console ?? [])}`;
    for (const text of [d.title, d.explanation])
      for (const bad of ['{{', 'undefined']) if (!raw.includes(bad)) expect(text).not.toContain(bad);
  });

  it('writes explanations with the real values', () => {
    const d = diagnose(input(api(200, 401)));
    expect(d.title).toBe('The API accepted a request it should have rejected (200 instead of 401)');
    expect(d.explanation).toBe(
      'GET http://127.0.0.1:8101/api/appointments answered 200 OK although the test expected 401 Unauthorized. The endpoint does not check authentication or permissions.',
    );
    expect(d.evidence).toEqual([
      { label: 'Request', value: 'GET http://127.0.0.1:8101/api/appointments' },
      { label: 'Expected', value: '401 Unauthorized' },
      { label: 'Actual', value: '200 OK' },
    ]);
    const orphan = diagnose(
      input(
        step({
          type: 'db.query',
          errorKind: 'assertion',
          message: 'm',
          query: {
            connection: 'clinic',
            sql: 'SELECT COUNT(*) AS n FROM appointments WHERE patient_id = 1',
            rowCount: 1,
          },
          assertions: [
            {
              target: 'value',
              operator: 'equals',
              expected: 0,
              actual: 1,
              passed: false,
              message: 'Expected value equals 0, but got 1',
            },
          ],
        }),
      ),
    );
    expect(orphan.title).toBe('The database holds 1 where 0 was expected');
    expect(orphan.explanation).toContain('(difference +1)');
    const loc = diagnose(
      input(
        step({
          type: 'ui.click',
          errorKind: 'element_not_found',
          message: 'x',
          locators: [{ strategy: 'testId', value: 'save-btn' }],
          diagnostics: {
            matchCount: 0,
            candidates: [
              {
                locator: { strategy: 'testId', value: 'save-patient' },
                text: 'Save patient',
                score: 0.8,
                count: 1,
              },
            ],
          },
        }),
      ),
    );
    expect(loc.title).toBe(
      'The element changed: testId=save-btn matches nothing, but testId=save-patient looks like it',
    );
    expect(loc.suggestedLocator).toEqual({ strategy: 'testId', value: 'save-patient' });
  });

  it('compares with the last passing run', () => {
    const failed = api(200, 401, { durationMs: 40 });
    const d = diagnose(
      input(failed, {
        lastGreen: {
          runId: 'R1',
          at: '2026-10-01T10:00:00.000Z',
          step: { ...failed, status: 'passed', response: { status: 401, body: [] } },
          browser: 'chromium',
        },
        current: { browser: 'firefox' },
      }),
    );
    expect(d.lastGreen?.changes).toEqual([
      { what: 'Step result', before: 'passed', after: 'failed' },
      { what: 'HTTP status', before: '401', after: '200' },
      { what: 'Browser', before: 'chromium', after: 'firefox' },
    ]);
    expect(d.evidence.at(-1)).toEqual({
      label: 'Since the last pass',
      value: 'Step result: passed → failed; HTTP status: 401 → 200; Browser: chromium → firefox',
    });
    const perf = diagnose(
      input(
        step({
          type: 'perf.loadTest',
          errorKind: 'assertion',
          message: 'p95',
          assertions: [
            {
              target: 'p95',
              operator: 'lt',
              expected: 800,
              actual: 912,
              passed: false,
              message: 'p95 latency 912 ms exceeded the threshold of 800 ms by 112 ms',
            },
          ],
        }),
        {
          lastGreen: {
            runId: 'R0',
            at: 'x',
            step: step({ type: 'perf.loadTest', status: 'passed', perf: { latency: { p95: 410 } } }),
          },
        },
      ),
    );
    expect(perf.category).toBe('perf_regression');
    expect(perf.explanation).toBe(
      'The last passing run had a p95 of 410 ms, so this is a regression since then.',
    );
  });
});
