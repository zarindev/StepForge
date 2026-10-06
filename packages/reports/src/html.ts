import { CREDIT, DEFAULT_BRANDING, type Branding, type BugReportData, type RunReportData } from './types.ts';

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const OWNER: Record<string, string> = {
  app: 'Application',
  test: 'Test',
  environment: 'Environment',
  data: 'Test data',
};
const STATUS_COLOR: Record<string, string> = {
  passed: '#16a34a',
  failed: '#dc2626',
  broken: '#d97706',
  flaky: '#ca8a04',
  skipped: '#64748b',
  critical: '#b91c1c',
  major: '#dc2626',
  minor: '#d97706',
  trivial: '#64748b',
};

const dt = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const dur = (ms?: number) =>
  ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const badge = (text: string, color = '#64748b') =>
  `<span class="badge" style="background:${color}1a;color:${color};border-color:${color}55">${esc(text)}</span>`;

function page(title: string, body: string, b: Branding): string {
  const accent = b.accent ?? DEFAULT_BRANDING.accent;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="author" content="${esc(b.author)}"><meta name="generator" content="${esc(CREDIT)}">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:0;padding:32px;font-size:13px;line-height:1.5;background:#fff}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px;padding-bottom:4px;border-bottom:2px solid ${accent}}
.muted{color:#64748b}.mono{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px}
.badge{display:inline-block;border:1px solid;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:4px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
th{font-size:11px;color:#64748b;font-weight:600;background:#f8fafc}
.grid{display:grid;grid-template-columns:160px 1fr;gap:4px 12px}.grid div:nth-child(odd){color:#64748b}
.box{border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:8px 0}
.why{border-left:4px solid ${accent};background:${accent}0d}
pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;margin:4px 0}
img.shot{max-width:100%;border:1px solid #e2e8f0;border-radius:6px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px}
.brand{text-align:right;font-size:11px;white-space:nowrap;flex-shrink:0}.brand strong{color:${accent}}
footer{margin-top:32px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;display:flex;justify-content:space-between}
.item{page-break-inside:avoid}.bug{page-break-after:always}.bug:last-child{page-break-after:auto}
@media print{body{padding:0}}
</style></head><body>
${body}
<footer><span>Prepared by ${esc(b.author)}${b.company ? ` · ${esc(b.company)}` : ''}</span><span>Generated ${esc(dt(new Date().toISOString()))} · ${esc(CREDIT)}</span></footer>
</body></html>`;
}

function header(title: string, subtitle: string, b: Branding) {
  return `<header><div><h1>${esc(title)}</h1><div class="muted">${subtitle}</div></div>
<div class="brand"><strong>StepForge</strong><br>Prepared by ${esc(b.author)}${b.company ? `<br>${esc(b.company)}` : ''}</div></header>`;
}

function bugBody(bug: BugReportData): string {
  const d = bug.diagnosis;
  const env = bug.environment;
  return `<section class="bug">
${badge(bug.severity, STATUS_COLOR[bug.severity])}${badge(bug.priority)}${badge(bug.status.replace('_', ' '))}${bug.owner ? badge(`Owner: ${OWNER[bug.owner] ?? bug.owner}`) : ''}${bug.occurrences > 1 ? badge(`${bug.occurrences} occurrences`) : ''}
<h2>Summary</h2><p>${esc(bug.summary).replace(/\n/g, '<br>')}</p>
<div class="grid">
<div>Application</div><div>${esc(bug.application)}${bug.module ? ` › ${esc(bug.module)}` : ''}</div>
${bug.scenario ? `<div>Scenario</div><div>${esc(bug.scenario)}</div>` : ''}
${bug.testCase ? `<div>Test case</div><div>${esc(bug.testCase)}</div>` : ''}
<div>Environment</div><div>${esc(env.name ?? '—')} · <span class="mono">${esc(env.url ?? '')}</span></div>
<div>Browser / viewport</div><div>${esc(env.browser ?? '—')} · ${esc(env.viewport ?? '—')}</div>
<div>Operating system</div><div>${esc(env.os ?? '—')}</div>
<div>First seen / last seen</div><div>${esc(dt(bug.createdAt))} / ${esc(dt(bug.lastSeenAt ?? bug.createdAt))}</div>
</div>
${bug.preconditions ? `<h2>Preconditions</h2><p>${esc(bug.preconditions)}</p>` : ''}
<h2>Steps to reproduce</h2><pre>${esc(bug.steps.join('\n'))}</pre>
<h2>Expected</h2><p>${esc(bug.expected)}</p>
<h2>Actual</h2><p>${esc(bug.actual)}</p>
${
  d
    ? `<h2>Diagnosis</h2><div class="box why">
<p><strong>Where:</strong> ${esc(d.where?.path ? `step ${d.where.path} — ` : '')}${esc(d.where?.step ?? '')}</p>
<p><strong>Why (likely):</strong> ${esc(d.title)}<br><span class="muted">${esc(d.explanation)}</span></p>
<p><strong>Whose issue:</strong> ${esc(OWNER[d.owner] ?? d.owner)} <span class="muted">(confidence ${Math.round(d.confidence * 100)}%)</span></p>
<p><strong>How to fix:</strong> ${esc(d.fix)}</p>
${d.evidence?.length ? `<table>${d.evidence.map((e) => `<tr><th style="width:160px">${esc(e.label)}</th><td class="mono">${esc(e.value)}</td></tr>`).join('')}</table>` : ''}
</div>`
    : ''
}
<h2>Evidence</h2>
${bug.evidence.screenshot ? `<p class="muted">Failure screenshot (the failing element is outlined in red when it exists):</p><img class="shot" src="${bug.evidence.screenshot}" alt="Failure screenshot">` : ''}
${bug.evidence.request ? `<p><strong>Request</strong></p><pre>${esc(bug.evidence.request)}</pre>` : ''}
${bug.evidence.response ? `<p><strong>Response</strong></p><pre>${esc(bug.evidence.response)}</pre>` : ''}
${bug.evidence.files.length ? `<p class="muted">Also available in StepForge: ${esc(bug.evidence.files.join(', '))}</p>` : ''}
</section>`;
}

export function bugHtml(bug: BugReportData, b: Branding = DEFAULT_BRANDING): string {
  return page(
    `${bug.code} ${bug.title}`,
    `${header(`${bug.code} · ${bug.title}`, `Bug report · ${esc(bug.application)}`, b)}${bugBody(bug)}`,
    b,
  );
}

export function bugListHtml(bugs: BugReportData[], title: string, b: Branding = DEFAULT_BRANDING): string {
  const rows = bugs
    .map(
      (x) =>
        `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.title)}</td><td>${badge(x.severity, STATUS_COLOR[x.severity])}</td><td>${esc(x.priority)}</td><td>${esc(x.status.replace('_', ' '))}</td><td>${esc(OWNER[x.owner ?? ''] ?? '—')}</td><td>${x.occurrences}</td><td>${esc(dt(x.lastSeenAt ?? x.createdAt))}</td></tr>`,
    )
    .join('');
  return page(
    title,
    `${header(title, `${bugs.length} bug${bugs.length === 1 ? '' : 's'}`, b)}
<table><thead><tr><th>ID</th><th>Title</th><th>Severity</th><th>Priority</th><th>Status</th><th>Owner</th><th>Seen</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody></table>
<div style="page-break-after:always"></div>
${bugs.map((x) => `<h1 style="margin-top:24px">${esc(x.code)} · ${esc(x.title)}</h1>${bugBody(x)}`).join('')}`,
    b,
  );
}

/** A self-contained run report (screenshots embedded), viewable offline and printable to PDF. */
export function runReportHtml(r: RunReportData, b: Branding = DEFAULT_BRANDING): string {
  const t = r.run.totals;
  const passRate = t.total ? Math.round(((t.passed + t.flaky) / t.total) * 100) : 0;
  const summary = `<table style="width:auto"><tr>${[
    ['Status', badge(r.run.status, STATUS_COLOR[r.run.status] ?? '#64748b')],
    ['Tests', String(t.total)],
    ['Passed', String(t.passed)],
    ['Failed', String(t.failed)],
    ['Broken', String(t.broken)],
    ['Flaky', String(t.flaky)],
    ['Skipped', String(t.skipped)],
    ['Pass rate', `${passRate}%`],
    ['Duration', dur(r.run.durationMs)],
  ]
    .map(
      ([k, v]) =>
        `<td><div class="muted" style="font-size:11px">${k}</div><div style="font-size:15px;font-weight:600">${v}</div></td>`,
    )
    .join('')}</tr></table>`;
  const items = r.items
    .map(
      (it) => `<div class="item box">
<div>${badge(it.status, STATUS_COLOR[it.status])} <strong>${esc(it.title)}</strong> <span class="muted">${esc(it.module ?? '')} · ${dur(it.durationMs)}</span></div>
${it.error ? `<p style="color:#dc2626">${esc(it.error)}</p>` : ''}
${it.diagnosis ? `<div class="box why"><strong>${esc(it.diagnosis.title)}</strong><br><span class="muted">${esc(it.diagnosis.explanation)}</span><br>Whose issue: ${esc(OWNER[it.diagnosis.owner] ?? it.diagnosis.owner)} · Fix: ${esc(it.diagnosis.fix)}</div>` : ''}
${
  it.steps.length && it.status !== 'passed'
    ? `<table><thead><tr><th style="width:50px">#</th><th>Step</th><th style="width:70px">Result</th><th style="width:70px">Time</th></tr></thead><tbody>${it.steps
        .map(
          (s) =>
            `<tr><td class="mono">${esc(s.path)}</td><td>${esc(s.label)}${s.message && s.status !== 'passed' ? `<br><span class="muted">${esc(s.message)}</span>` : ''}</td><td style="color:${STATUS_COLOR[s.status] ?? '#0f172a'}">${esc(s.status)}</td><td>${dur(s.durationMs)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}
${it.screenshot ? `<img class="shot" src="${it.screenshot}" alt="Failure screenshot of ${esc(it.title)}">` : ''}
</div>`,
    )
    .join('');
  return page(
    `Run report — ${r.application}`,
    `${header(`Run report — ${r.application}`, `${esc(r.environment.name ?? '')} · <span class="mono">${esc(r.environment.url ?? '')}</span> · ${esc(r.run.browser ?? '')} ${esc(r.run.viewport ?? '')} · started ${esc(dt(r.run.startedAt))} · run ${esc(r.run.id)}`, b)}
${summary}<h2>Tests</h2>${items}`,
    b,
  );
}
