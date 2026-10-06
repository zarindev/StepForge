import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runJunit, type RunReportData } from '../src/index.ts';

const run: RunReportData = {
  application: 'CareClinic',
  environment: { name: 'Staging', url: 'http://127.0.0.1:8090' },
  run: {
    id: 'RUN1',
    status: 'failed',
    startedAt: '2026-10-07T02:00:00.000Z',
    durationMs: 4250,
    browser: 'chromium',
    totals: { total: 4, passed: 1, failed: 1, broken: 1, skipped: 1, flaky: 0 },
  },
  items: [
    { title: 'Login works', module: 'Auth', status: 'passed', durationMs: 1200, steps: [] },
    {
      title: 'Double booking <rejected> & "logged"',
      module: 'Booking',
      status: 'failed',
      durationMs: 800,
      error: 'expected status 409 but got 201\u0007',
      diagnosis: {
        category: 'api',
        title: 'The API accepted a duplicate (201 instead of 409 Conflict)',
        explanation: 'A second identical booking was created.',
        owner: 'Backend',
        fix: 'Add a uniqueness check.',
        confidence: 0.9,
      },
      steps: [{ path: '1', label: 'POST /api/bookings', status: 'failed', message: '201 ≠ 409' }],
    },
    { title: 'Server down', module: 'Booking', status: 'broken', error: 'ECONNREFUSED', steps: [] },
    { title: 'Not yet', module: 'Booking', status: 'skipped', steps: [] },
  ],
};

describe('JUnit XML', () => {
  const xml = runJunit(run);

  it('maps modules to suites and statuses to failure/error/skipped', () => {
    expect(xml).toContain(
      '<testsuites name="StepForge · CareClinic" tests="4" failures="1" errors="1" skipped="1" time="4.250">',
    );
    expect(xml).toContain(
      '<testsuite name="Auth" tests="1" failures="0" errors="0" skipped="0" time="1.200"',
    );
    expect(xml).toContain('<testsuite name="Booking" tests="3" failures="1" errors="1" skipped="1"');
    expect(xml).toContain(
      '<testcase name="Double booking &lt;rejected&gt; &amp; &quot;logged&quot;" classname="CareClinic.Booking" time="0.800"><failure message="The API accepted a duplicate (201 instead of 409 Conflict)" type="api">',
    );
    expect(xml).toContain('<error message="ECONNREFUSED" type="Error">ECONNREFUSED</error>');
    expect(xml).toContain('<skipped/>');
    expect(xml).toContain('<system-out>1 POST /api/bookings — failed: 201 ≠ 409</system-out>');
    expect(xml).not.toContain('\u0007'); // control characters are invalid in XML
    expect(xml).toContain('<!-- StepForge by Md Zarin Tasnim · prepared by Md Zarin Tasnim -->');
    expect(xml).toContain('<property name="preparedBy" value="Md Zarin Tasnim"/>');
  });

  it.skipIf(!existsSync('/usr/bin/xmllint'))('is well-formed XML', () => {
    expect(() =>
      execFileSync('/usr/bin/xmllint', ['--noout', '-'], { input: xml, stdio: 'pipe' }),
    ).not.toThrow();
  });
});
