import ExcelJS from 'exceljs';
import { CREDIT, DEFAULT_BRANDING, type Branding, type BugReportData, type RunReportData } from './types.ts';

const OWNER: Record<string, string> = {
  app: 'Application',
  test: 'Test',
  environment: 'Environment',
  data: 'Test data',
};

/** A GitHub issue body (Markdown). */
export function bugMarkdown(bug: BugReportData, b: Branding = DEFAULT_BRANDING): string {
  const d = bug.diagnosis;
  const env = bug.environment;
  const lines = [
    `## ${bug.code}: ${bug.title}`,
    '',
    `**Severity:** ${bug.severity} · **Priority:** ${bug.priority} · **Status:** ${bug.status.replace('_', ' ')}${bug.owner ? ` · **Likely owner:** ${OWNER[bug.owner] ?? bug.owner}` : ''}${bug.occurrences > 1 ? ` · **Seen:** ${bug.occurrences}×` : ''}`,
    '',
    bug.summary,
    '',
    '### Environment',
    `- Application: ${bug.application}${bug.module ? ` › ${bug.module}` : ''}`,
    ...(bug.scenario ? [`- Scenario: ${bug.scenario}`] : []),
    ...(bug.testCase ? [`- Test case: ${bug.testCase}`] : []),
    `- URL: ${env.url ?? '—'} (${env.name ?? '—'})`,
    `- Browser: ${env.browser ?? '—'}, viewport ${env.viewport ?? '—'}`,
    `- OS: ${env.os ?? '—'}`,
    `- Last seen: ${bug.lastSeenAt ?? bug.createdAt}`,
    '',
    ...(bug.preconditions ? ['### Preconditions', bug.preconditions, ''] : []),
    '### Steps to reproduce',
    '```',
    ...bug.steps,
    '```',
    '',
    '### Expected',
    bug.expected,
    '',
    '### Actual',
    bug.actual,
    '',
    ...(d
      ? [
          '### Diagnosis',
          `- **Where:** ${d.where?.path ? `step ${d.where.path} — ` : ''}${d.where?.step ?? ''}`,
          `- **Why (likely):** ${d.title} — ${d.explanation}`,
          `- **Whose issue:** ${OWNER[d.owner] ?? d.owner} (confidence ${Math.round(d.confidence * 100)}%)`,
          `- **How to fix:** ${d.fix}`,
          ...(d.evidence ?? []).map((e) => `- ${e.label}: \`${e.value.replace(/`/g, "'")}\``),
          '',
        ]
      : []),
    ...(bug.evidence.request
      ? ['<details><summary>Request</summary>', '', '```', bug.evidence.request, '```', '</details>', '']
      : []),
    ...(bug.evidence.response
      ? ['<details><summary>Response</summary>', '', '```', bug.evidence.response, '```', '</details>', '']
      : []),
    '---',
    `_Prepared by ${b.author}${b.company ? ` (${b.company})` : ''} with ${CREDIT}._`,
  ];
  return lines.join('\n');
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const JIRA_PRIORITY: Record<string, string> = { P1: 'Highest', P2: 'High', P3: 'Medium', P4: 'Low' };

function description(bug: BugReportData, b: Branding) {
  return [
    bug.summary,
    '',
    'Steps to reproduce:',
    ...bug.steps,
    '',
    `Expected: ${bug.expected}`,
    `Actual: ${bug.actual}`,
    '',
    `Environment: ${bug.environment.name ?? ''} ${bug.environment.url ?? ''} · ${bug.environment.browser ?? ''}`,
    `Prepared by ${b.author} with ${CREDIT}`,
  ].join('\n');
}

/**
 * CSV for import into Jira (Summary, Issue Type, Priority, Description, Labels…) or Trello (Card Name,
 * Card Description, Labels, List).
 */
export function bugsCsv(
  bugs: BugReportData[],
  format: 'jira' | 'trello' = 'jira',
  b: Branding = DEFAULT_BRANDING,
): string {
  const rows =
    format === 'jira'
      ? [
          ['Summary', 'Issue Type', 'Priority', 'Description', 'Labels', 'Severity', 'Status', 'External ID'],
          ...bugs.map((x) => [
            `${x.code} ${x.title}`,
            'Bug',
            JIRA_PRIORITY[x.priority] ?? 'Medium',
            description(x, b),
            ['stepforge', x.severity, x.diagnosis?.category ?? ''].filter(Boolean).join(' '),
            x.severity,
            x.status,
            x.code,
          ]),
        ]
      : [
          ['Card Name', 'Card Description', 'Labels', 'List'],
          ...bugs.map((x) => [
            `${x.code} ${x.title}`,
            description(x, b),
            [x.severity, x.priority, x.diagnosis?.category].filter(Boolean).join(','),
            x.status === 'open' ? 'To Do' : x.status === 'in_progress' ? 'Doing' : 'Done',
          ]),
        ];
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function styleHeader(ws: ExcelJS.Worksheet, accent: string) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${accent.replace('#', '').toUpperCase()}` },
  };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function workbook(b: Branding) {
  const wb = new ExcelJS.Workbook();
  wb.creator = b.author;
  wb.lastModifiedBy = b.author;
  wb.company = b.company ?? '';
  wb.created = new Date();
  wb.description = `Generated with ${CREDIT}`;
  return wb;
}

function aboutSheet(wb: ExcelJS.Workbook, title: string, b: Branding) {
  const ws = wb.addWorksheet('About');
  ws.columns = [{ width: 22 }, { width: 60 }];
  ws.addRows([
    ['Report', title],
    ['Prepared by', b.author],
    ...(b.company ? [['Company', b.company]] : []),
    ['Generated', new Date().toISOString()],
    ['Generated with', CREDIT],
  ]);
  ws.getColumn(1).font = { bold: true };
}

export async function bugsXlsx(bugs: BugReportData[], b: Branding = DEFAULT_BRANDING): Promise<Buffer> {
  const wb = workbook(b);
  const ws = wb.addWorksheet('Bugs');
  ws.columns = [
    { header: 'Bug ID', key: 'code', width: 10 },
    { header: 'Title', key: 'title', width: 60 },
    { header: 'Severity', key: 'severity', width: 10 },
    { header: 'Priority', key: 'priority', width: 9 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Likely owner', key: 'owner', width: 14 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Application', key: 'application', width: 18 },
    { header: 'Scenario', key: 'scenario', width: 30 },
    { header: 'Environment', key: 'env', width: 30 },
    { header: 'Expected', key: 'expected', width: 40 },
    { header: 'Actual', key: 'actual', width: 40 },
    { header: 'Steps to reproduce', key: 'steps', width: 60 },
    { header: 'How to fix', key: 'fix', width: 50 },
    { header: 'Occurrences', key: 'occurrences', width: 12 },
    { header: 'First seen', key: 'created', width: 20 },
    { header: 'Last seen', key: 'last', width: 20 },
  ];
  for (const x of bugs)
    ws.addRow({
      code: x.code,
      title: x.title,
      severity: x.severity,
      priority: x.priority,
      status: x.status,
      owner: OWNER[x.owner ?? ''] ?? '',
      category: x.diagnosis?.category ?? '',
      application: x.application,
      scenario: x.scenario ?? '',
      env: `${x.environment.name ?? ''} ${x.environment.url ?? ''}`.trim(),
      expected: x.expected,
      actual: x.actual,
      steps: x.steps.join('\n'),
      fix: x.diagnosis?.fix ?? '',
      occurrences: x.occurrences,
      created: x.createdAt,
      last: x.lastSeenAt ?? x.createdAt,
    });
  ws.getColumn('steps').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(ws, b.accent ?? '#F97316');
  aboutSheet(wb, 'Bug list', b);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function runXlsx(r: RunReportData, b: Branding = DEFAULT_BRANDING): Promise<Buffer> {
  const wb = workbook(b);
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 18 }, { width: 50 }];
  const t = r.run.totals;
  summary.addRows([
    ['Application', r.application],
    ['Environment', `${r.environment.name ?? ''} ${r.environment.url ?? ''}`],
    ['Run', r.run.id],
    ['Status', r.run.status],
    ['Started', r.run.startedAt ?? ''],
    ['Duration (s)', r.run.durationMs !== undefined ? Math.round(r.run.durationMs / 100) / 10 : ''],
    ['Browser', `${r.run.browser ?? ''} ${r.run.viewport ?? ''}`],
    ['Tests', t.total],
    ['Passed', t.passed],
    ['Failed', t.failed],
    ['Broken', t.broken],
    ['Flaky', t.flaky],
    ['Skipped', t.skipped],
    ['Prepared by', b.author],
  ]);
  summary.getColumn(1).font = { bold: true };
  const tests = wb.addWorksheet('Tests');
  tests.columns = [
    { header: 'Test', key: 'title', width: 50 },
    { header: 'Module', key: 'module', width: 20 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Duration (ms)', key: 'dur', width: 14 },
    { header: 'Error', key: 'error', width: 60 },
    { header: 'Diagnosis', key: 'diag', width: 50 },
    { header: 'Likely owner', key: 'owner', width: 14 },
    { header: 'How to fix', key: 'fix', width: 50 },
  ];
  for (const it of r.items)
    tests.addRow({
      title: it.title,
      module: it.module ?? '',
      status: it.status,
      dur: it.durationMs ?? '',
      error: it.error ?? '',
      diag: it.diagnosis?.title ?? '',
      owner: OWNER[it.diagnosis?.owner ?? ''] ?? '',
      fix: it.diagnosis?.fix ?? '',
    });
  styleHeader(tests, b.accent ?? '#F97316');
  const steps = wb.addWorksheet('Steps');
  steps.columns = [
    { header: 'Test', key: 'test', width: 40 },
    { header: '#', key: 'path', width: 6 },
    { header: 'Step', key: 'label', width: 50 },
    { header: 'Result', key: 'status', width: 10 },
    { header: 'Duration (ms)', key: 'dur', width: 14 },
    { header: 'Message', key: 'msg', width: 60 },
  ];
  for (const it of r.items)
    for (const s of it.steps)
      steps.addRow({
        test: it.title,
        path: s.path,
        label: s.label,
        status: s.status,
        dur: s.durationMs ?? '',
        msg: s.message ?? '',
      });
  styleHeader(steps, b.accent ?? '#F97316');
  aboutSheet(wb, `Run report — ${r.application}`, b);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
