import { describe, expect, it } from 'vitest';
import { describeStep, describeSteps } from '../src/index.ts';

const s = (
  type: string,
  params: Record<string, unknown> = {},
  locators: { strategy: never; value: string; name?: string }[] = [],
) => ({
  type,
  params,
  locators: locators as never,
});

describe('plain English', () => {
  it.each([
    [s('ui.navigate', { url: '/login' }), 'Open /login'],
    [
      s('ui.fill', { value: '{{data.email}}' }, [{ strategy: 'label' as never, value: 'Email' }]),
      'Type "{{data.email}}" into the "Email" field',
    ],
    [
      s('ui.click', {}, [{ strategy: 'role' as never, value: 'button', name: 'Sign in' }]),
      'Click the "Sign in" button',
    ],
    [
      s('ui.select', { label: 'Doctor' }, [{ strategy: 'role' as never, value: 'combobox', name: 'Role' }]),
      'Select "Doctor" in the "Role" dropdown',
    ],
    [
      s('ui.assert', { check: 'textContains', expected: 'Welcome' }, [
        { strategy: 'testId' as never, value: 'flash' },
      ]),
      'Check that the element "flash" contains "Welcome"',
    ],
    [
      s('ui.assert', { check: 'urlContains', expected: '/dashboard' }),
      'Check that the URL contains "/dashboard"',
    ],
    [s('api.request', { method: 'POST', url: '/api/patients' }), 'Send POST /api/patients'],
    [s('util.loop', { count: 3 }), 'Repeat 3 times'],
    [
      s('email.waitForEmail', { to: '{{vars.email}}', subject: 'Verify' }),
      'Wait for an email to {{vars.email}} with subject "Verify"',
    ],
    [
      s('email.assertEmail', { subjectContains: 'Verify', hasLink: '/verify' }),
      'Check that the subject contains "Verify" and it has a link containing "/verify"',
    ],
    [s('email.extractFromEmail', { kind: 'otp' }), 'Read the one-time code from the email'],
    [
      s('email.extractFromEmail', { kind: 'link', contains: 'reset' }),
      'Read the "reset" link from the email',
    ],
    [s('email.openEmailLink', { contains: '/verify' }), 'Open the "/verify" link in the email'],
    [s('db.query', { sql: 'SELECT 1', connection: 'main' }), 'Run the SQL query "SELECT 1" on main'],
    [
      s('perf.loadTest', { url: '/api/products', vus: 50, profile: 'stress' }),
      'Load test /api/products with 50 users (stress)',
    ],
    [s('perf.lighthouse', { url: '/checkout' }), 'Run Lighthouse on /checkout'],
    [s('api.extract', { path: '$.token' }), 'Read $.token from the response'],
  ])('%#', (step, text) => {
    expect(describeStep(step)).toBe(text);
  });

  it('numbers nested steps and appends labels and captures', () => {
    const lines = describeSteps([
      { ...s('ui.navigate', { url: '/' }), label: 'Home' },
      {
        ...s('util.if', {
          condition: { value: '{{vars.n}}', operator: 'gt', expected: 1 },
          steps: [s('util.log', { message: 'a' })],
          else: [s('util.log', { message: 'b' })],
        }),
      },
      {
        ...s('ui.extract', { from: 'text' }, [{ strategy: 'css' as never, value: '#code' }]),
        captureAs: 'code',
      },
      { ...s('ui.click'), enabled: false },
    ]);
    expect(lines.map((l) => `${l.number} ${l.text}`)).toEqual([
      '1 Open / — Home',
      '2 If {{vars.n}} gt "1"',
      '2.1 Note: a',
      '2e Otherwise',
      '2e.1 Note: b',
      '3 Read the text of the element "#code" (save as code)',
    ]);
  });
});

describe('describeTarget', () => {
  it('prefers a readable fallback locator over a test id for descriptions', () => {
    expect(
      describeStep({
        type: 'ui.click',
        params: {},
        locators: [
          { strategy: 'testId', value: 'login-submit' },
          { strategy: 'role', value: 'button', name: 'Sign in' },
        ],
      }),
    ).toBe('Click the "Sign in" button');
  });
});

describe('assert phrasing', () => {
  it('avoids repeating the text when the target is described by it', () => {
    expect(
      describeStep({
        type: 'ui.assert',
        params: { check: 'text', expected: 'Saved' },
        locators: [{ strategy: 'text', value: 'Saved' }],
      }),
    ).toBe('Check that "Saved" is shown');
  });
});
