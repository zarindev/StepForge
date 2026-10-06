import { CREDIT, DEFAULT_BRANDING, type Branding, type RunReportData, type RunReportItem } from './types.ts';

/** XML 1.0 text: escapes markup and drops characters XML cannot carry (CI parsers reject them). */
const x = (s: unknown) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const secs = (ms?: number) => ((ms ?? 0) / 1000).toFixed(3);

function testcase(r: RunReportData, i: RunReportItem): string {
  // CI viewers group test classes by dots: "Catalogue › Checkout" becomes Catalogue.Checkout.
  const classname = [r.application, ...(i.module?.split(/\s*›\s*/) ?? [])].filter(Boolean).join('.');
  const steps = i.steps
    .map((s) => `${s.path} ${s.label} — ${s.status}${s.message ? `: ${s.message}` : ''}`)
    .join('\n');
  const detail = [
    i.error,
    i.diagnosis &&
      `Diagnosis: ${i.diagnosis.title}\n${i.diagnosis.explanation}\nLikely owner: ${i.diagnosis.owner}\nFix: ${i.diagnosis.fix}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const message = i.diagnosis?.title ?? i.error?.split('\n')[0] ?? i.status;
  const body =
    i.status === 'failed'
      ? `<failure message="${x(message)}" type="${x(i.diagnosis?.category ?? 'AssertionError')}">${x(detail)}</failure>`
      : i.status === 'broken'
        ? `<error message="${x(message)}" type="${x(i.diagnosis?.category ?? 'Error')}">${x(detail)}</error>`
        : i.status === 'skipped' || i.status === 'cancelled'
          ? '<skipped/>'
          : '';
  const out = steps ? `<system-out>${x(steps)}</system-out>` : '';
  return `    <testcase name="${x(i.title)}" classname="${x(classname)}" time="${secs(i.durationMs)}">${body}${out}</testcase>`;
}

/** A run as JUnit XML (one <testsuite> per module) for CI test-result viewers. */
export function runJunit(r: RunReportData, b: Branding = DEFAULT_BRANDING): string {
  const modules = new Map<string, RunReportItem[]>();
  for (const i of r.items) {
    const m = i.module ?? r.application;
    modules.set(m, [...(modules.get(m) ?? []), i]);
  }
  const count = (items: RunReportItem[], ...s: string[]) => items.filter((i) => s.includes(i.status)).length;
  const sum = (items: RunReportItem[]) => items.reduce((t, i) => t + (i.durationMs ?? 0), 0);
  const suites = [...modules].map(([name, items]) =>
    [
      `  <testsuite name="${x(name)}" tests="${items.length}" failures="${count(items, 'failed')}" errors="${count(items, 'broken')}" skipped="${count(items, 'skipped', 'cancelled')}" time="${secs(sum(items))}"${r.run.startedAt ? ` timestamp="${x(r.run.startedAt.replace(/Z$/, ''))}"` : ''} hostname="localhost">`,
      '    <properties>',
      `      <property name="environment" value="${x(r.environment.name)}"/>`,
      ...(r.environment.url ? [`      <property name="baseUrl" value="${x(r.environment.url)}"/>`] : []),
      ...(r.run.browser ? [`      <property name="browser" value="${x(r.run.browser)}"/>`] : []),
      `      <property name="runId" value="${x(r.run.id)}"/>`,
      `      <property name="preparedBy" value="${x(b.author)}"/>`,
      '    </properties>',
      ...items.map((i) => testcase(r, i)),
      '  </testsuite>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${CREDIT} · prepared by ${x(b.author).replace(/--/g, '—')} -->`,
    `<testsuites name="${x(`StepForge · ${r.application}`)}" tests="${r.items.length}" failures="${count(r.items, 'failed')}" errors="${count(r.items, 'broken')}" skipped="${count(r.items, 'skipped', 'cancelled')}" time="${secs(r.run.durationMs ?? sum(r.items))}">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}
