import { describeStep } from '@stepforge/core';
import ExcelJS from 'exceljs';
import { CREDIT, day } from '../common.ts';
import type { Plan } from '../ir.ts';
import type { CodegenInput, CodegenScenario, CodegenStep, GeneratedProject } from '../types.ts';
import { kebab } from '../values.ts';

/** Test documentation: Markdown, Gherkin .feature files and an Excel workbook. */

type Line = {
  number: string;
  text: string;
  /** StepForge's sentence alone (without the step's label). */
  plain: string;
  depth: number;
  type: string;
  assertion: boolean;
  /** The step's own checks, e.g. "status equals 200". */
  checks: string[];
};

const OPERATOR: Record<string, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  matches: 'matches',
  lt: 'is below',
  lte: 'is at most',
  gt: 'is above',
  gte: 'is at least',
  exists: 'exists',
  notExists: 'does not exist',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  lengthEquals: 'has length',
};

/** Numbered plain-English steps; reusable blocks and called scenarios are expanded so the steps read completely. */
export function stepLines(
  input: CodegenInput,
  steps: CodegenStep[],
  prefix = '',
  depth = 0,
  seen = 0,
): Line[] {
  const out: Line[] = [];
  let n = 0;
  for (const raw of steps) {
    const step = {
      ...raw,
      params: raw.params ?? {},
      locators: raw.locators ?? [],
      assertions: raw.assertions ?? [],
    };
    if (step.enabled === false) continue;
    n++;
    const number = prefix ? `${prefix}.${n}` : String(n);
    const p = step.params;
    const target =
      step.type === 'util.useBlock'
        ? input.blocks[String(p.blockId)]
        : step.type === 'util.callScenario'
          ? input.library[String(p.scenarioId)]
          : undefined;
    if (target && seen < 5) {
      out.push({
        number,
        text: `${step.type === 'util.useBlock' ? 'Do' : 'Run the scenario'} “${target.name}”:`,
        depth,
        plain: target.name,
        type: step.type,
        assertion: false,
        checks: [],
      });
      out.push(...stepLines(input, target.steps, number, depth + 1, seen + 1));
      continue;
    }
    const text = describeStep(step as never);
    out.push({
      number,
      text: step.label?.trim() && step.label.trim() !== text ? `${text} — ${step.label.trim()}` : text,
      plain: text,
      depth,
      type: step.type,
      assertion:
        step.type === 'ui.assert' ||
        step.type === 'email.assertEmail' ||
        (step.assertions.length > 0 && !step.type.startsWith('util.')),
      checks: step.assertions.map(
        (a) =>
          `${a.target} ${OPERATOR[a.operator] ?? a.operator}${a.expected === undefined || a.expected === null ? '' : ` ${typeof a.expected === 'string' ? `"${a.expected}"` : JSON.stringify(a.expected)}`}`,
      ),
    });
    if (Array.isArray(p.steps))
      out.push(...stepLines(input, p.steps as CodegenStep[], number, depth + 1, seen));
    if (Array.isArray(p.else) && p.else.length) {
      out.push({
        number: `${number}e`,
        text: 'Otherwise:',
        depth: depth + 1,
        plain: 'Otherwise',
        type: 'else',
        assertion: false,
        checks: [],
      });
      out.push(...stepLines(input, p.else as CodegenStep[], `${number}e`, depth + 2, seen));
    }
  }
  return out;
}

const preparedBy = (input: CodegenInput) => `Prepared by ${input.author}`;
const fmtData = (d: Record<string, unknown>) =>
  Object.entries(d)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');

// ─── Markdown ───────────────────────────────────────────────────────────────
export function generateMarkdown(plan: Plan): GeneratedProject {
  const { input } = plan;
  const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const byModule = new Map<string, CodegenScenario[]>();
  for (const t of plan.tests) {
    const key = t.scenario.modulePath.join(' › ') || 'Scenarios';
    byModule.set(key, [...(byModule.get(key) ?? []), t.scenario]);
  }
  const out: string[] = [
    `# ${input.application.name} — test cases`,
    '',
    `${preparedBy(input)} · ${day(input)} · environment **${input.environment.name}** (${input.environment.baseUrl})`,
    '',
    `_${CREDIT}_`,
    '',
    `${plan.tests.length} scenario${plan.tests.length === 1 ? '' : 's'}, ${plan.tests.reduce((n, t) => n + Math.max(1, t.scenario.testCases.length), 0)} test case(s).`,
    '',
    '## Contents',
    '',
    ...[...byModule].flatMap(([m, list]) => [
      `- **${m}**`,
      ...list.map((s) => `  - [${s.name}](#${kebab(s.name)})`),
    ]),
  ];
  for (const [m, list] of byModule) {
    out.push('', `## ${m}`);
    for (const s of list) {
      const lines = stepLines(input, s.steps);
      out.push(
        '',
        `### ${s.name}`,
        '',
        `| Priority | Tags | Steps |`,
        '|---|---|---|',
        `| ${s.priority} | ${s.tags.map((t) => `#${t}`).join(' ') || '—'} | ${lines.length} |`,
        '',
        ...(s.description ? [s.description, ''] : []),
        ...(s.preconditions ? [`**Preconditions:** ${s.preconditions}`, ''] : []),
        '**Steps**',
        '',
        ...lines.map(
          (l) =>
            `${'   '.repeat(l.depth)}${l.depth ? '-' : `${l.number}.`} ${l.assertion ? '✔ ' : ''}${l.text}`,
        ),
        '',
      );
      if (s.testCases.length)
        out.push(
          '**Test cases**',
          '',
          '| ID | Title | Data | Expected result | Priority |',
          '|---|---|---|---|---|',
          ...s.testCases.map(
            (c) =>
              `| ${c.code} | ${md(c.title)} | ${md(fmtData(c.data)) || '—'} | ${md(c.expectedResult ?? '') || '—'} | ${c.priority ?? s.priority} |`,
          ),
          '',
        );
    }
  }
  out.push('---', '', `_${preparedBy(input)} · ${CREDIT}. ✔ marks steps with checks._`, '');
  const name = `${kebab(input.application.slug || input.application.name)}-test-cases.md`;
  return { target: 'docs-markdown', files: { [name]: out.join('\n') }, warnings: [], run: `Open ${name}` };
}

// ─── Gherkin ────────────────────────────────────────────────────────────────
/** "The dashboard is shown" → "the dashboard is shown" after Given/When/Then (acronyms like "URL" stay). */
const sentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
/** {{data.x}} becomes an outline parameter <x>; other placeholders stay readable. */
const gherkinText = (s: string, params: Set<string>) =>
  s.replace(/\{\{\s*data\.([\w.-]+)\s*\}\}/g, (_m, k: string) =>
    params.has(k) ? `<${k}>` : `{{data.${k}}}`,
  );

export function generateGherkin(plan: Plan): GeneratedProject {
  const { input } = plan;
  const files: Record<string, string> = {};
  const byModule = new Map<string, CodegenScenario[]>();
  for (const t of plan.tests) {
    const key = t.scenario.modulePath.join(' › ') || input.application.name;
    byModule.set(key, [...(byModule.get(key) ?? []), t.scenario]);
  }
  for (const [m, list] of byModule) {
    const out = [
      `# ${CREDIT} · ${preparedBy(input)} · ${day(input)}`,
      `Feature: ${m}`,
      `  ${input.application.name}, ${input.environment.name} environment.`,
    ];
    for (const s of list) {
      const columns = [...new Set(s.testCases.flatMap((c) => Object.keys(c.data)))];
      const params = new Set(columns);
      const outline = s.testCases.length > 0;
      const lines = stepLines(input, s.steps);
      out.push('', `  ${[...s.tags.map((t) => `@${kebab(t)}`), `@${s.priority.toLowerCase()}`].join(' ')}`);
      out.push(`  ${outline ? 'Scenario Outline' : 'Scenario'}: ${s.name}`);
      if (s.description) out.push(`    ${s.description}`);
      let previous = '';
      const keyword = (k: string) => {
        const word = k === previous ? 'And' : k;
        previous = k;
        return word;
      };
      if (s.preconditions)
        out.push(`    ${keyword('Given')} ${sentence(s.preconditions.replace(/\.$/, ''))}`);
      lines.forEach((l, i) => {
        if (l.type === 'else') {
          out.push(`    # Otherwise:`);
          return;
        }
        if (l.type === 'util.useBlock' || l.type === 'util.callScenario') {
          out.push(`    # ${l.plain}`);
          return;
        }
        const isCheck = l.type === 'ui.assert' || l.type === 'email.assertEmail';
        const kind = isCheck
          ? 'Then'
          : i === 0 && l.type === 'ui.navigate' && !s.preconditions
            ? 'Given'
            : 'When';
        // StepForge's plain-English sentence (the label alone is often too terse).
        const text = sentence(gherkinText(l.plain, params).replace(/:$/, '')).replace(/^check that /, '');
        out.push(`    ${keyword(kind)} ${text}`);
        if (!isCheck && l.checks.length)
          out.push(`    ${keyword('Then')} ${gherkinText(l.checks.join(' and '), params)}`);
      });
      if (outline) {
        const cols = ['id', ...columns];
        const rows = s.testCases.map((c) => [
          c.code,
          ...columns.map((k) =>
            c.data[k] === undefined
              ? ''
              : typeof c.data[k] === 'string'
                ? (c.data[k] as string)
                : JSON.stringify(c.data[k]),
          ),
        ]);
        const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));
        const row = (r: string[]) =>
          `      | ${r.map((x, i) => x.replace(/\|/g, '\\|').padEnd(widths[i]!)).join(' | ')} |`;
        out.push('', '    Examples:', row(cols), ...rows.map(row));
      }
    }
    files[`features/${kebab(m)}.feature`] = `${out.join('\n')}\n`;
  }
  files['README.md'] = [
    `# ${input.application.name} — Gherkin features`,
    '',
    `_${CREDIT} · ${preparedBy(input)} · ${day(input)}_`,
    '',
    'One `.feature` file per module. Scenarios with test cases are Scenario Outlines whose Examples are the test-case data',
    "(`{{data.x}}` became `<x>`). Steps are StepForge's plain-English descriptions: Given/When for actions, Then for checks.",
    'They document behaviour; to run them, bind the steps in Cucumber, Behave or SpecFlow, or export runnable tests instead.',
    '',
  ].join('\n');
  return { target: 'docs-gherkin', files, warnings: [], run: 'Open features/' };
}

// ─── Excel ──────────────────────────────────────────────────────────────────
export async function generateXlsx(plan: Plan): Promise<GeneratedProject> {
  const { input } = plan;
  const wb = new ExcelJS.Workbook();
  wb.creator = input.author;
  wb.lastModifiedBy = input.author;
  wb.title = `${input.application.name} test cases`;
  wb.company = CREDIT;
  wb.created = new Date(input.generatedAt);
  wb.modified = new Date(input.generatedAt);
  const ws = wb.addWorksheet('Test cases', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'ID', key: 'id', width: 14 },
    { header: 'Module', key: 'module', width: 18 },
    { header: 'Scenario', key: 'scenario', width: 30 },
    { header: 'Test case', key: 'title', width: 30 },
    { header: 'Priority', key: 'priority', width: 9 },
    { header: 'Tags', key: 'tags', width: 14 },
    { header: 'Preconditions', key: 'pre', width: 26 },
    { header: 'Steps', key: 'steps', width: 70 },
    { header: 'Test data', key: 'data', width: 30 },
    { header: 'Expected result', key: 'expected', width: 30 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Notes', key: 'notes', width: 20 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
  head.alignment = { vertical: 'middle' };
  let n = 0;
  for (const t of plan.tests) {
    const s = t.scenario;
    const steps = stepLines(input, s.steps)
      .map((l) => `${'    '.repeat(l.depth)}${l.number}. ${l.text}`)
      .join('\n');
    const checks = stepLines(input, s.steps)
      .filter((l) => l.assertion)
      .map((l) => `• ${l.text}`)
      .join('\n');
    const cases = s.testCases.length
      ? s.testCases
      : [{ code: '', title: s.name, data: {}, expectedResult: '' }];
    for (const c of cases) {
      n++;
      const row = ws.addRow({
        id: c.code || `SC-${String(n).padStart(3, '0')}`,
        module: s.modulePath.join(' › '),
        scenario: s.name,
        title: c.title,
        priority: ('priority' in c && c.priority) || s.priority,
        tags: s.tags.map((x) => `#${x}`).join(' '),
        pre: s.preconditions ?? '',
        steps,
        data: fmtData(c.data),
        expected: c.expectedResult || checks,
        status: '',
        notes: '',
      });
      row.alignment = { vertical: 'top', wrapText: true };
    }
  }
  ws.autoFilter = { from: 'A1', to: 'L1' };
  ws.getColumn('status').eachCell((cell, row) => {
    if (row > 1)
      cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Not run,Passed,Failed,Blocked"'] };
  });
  const about = wb.addWorksheet('About');
  about.columns = [{ width: 22 }, { width: 70 }];
  for (const [k, v] of [
    ['Application', input.application.name],
    ['Environment', `${input.environment.name} (${input.environment.baseUrl})`],
    ['Prepared by', input.author],
    ['Date', day(input)],
    ['Scenarios', String(plan.tests.length)],
    ['Generated by', CREDIT],
  ] as const)
    about.addRow([k, v]).getCell(1).font = { bold: true };
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const name = `${kebab(input.application.slug || input.application.name)}-test-cases.xlsx`;
  return {
    target: 'docs-xlsx',
    files: { [name]: buffer },
    warnings: [],
    run: `Open ${name} in Excel, LibreOffice or Google Sheets`,
  };
}
