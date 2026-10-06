import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  describeTarget,
  evaluateThresholds,
  planStages,
  validateLoadConfig,
  type LoadConfig,
  type LoadProfile,
  type LoadReport,
  type LoadThresholds,
  type Stage,
} from './load.ts';

/** Pinned for reproducible installs; override with STEPFORGE_K6_VERSION. */
export const K6_VERSION = process.env.STEPFORGE_K6_VERSION ?? 'v2.3.0';
const exe = process.platform === 'win32' ? 'k6.exe' : 'k6';

function k6Thresholds(t: LoadThresholds = {}): Record<string, string[]> {
  const dur = [
    t.p95Ms !== undefined && `p(95)<${t.p95Ms}`,
    t.p99Ms !== undefined && `p(99)<${t.p99Ms}`,
    t.avgMs !== undefined && `avg<${t.avgMs}`,
  ].filter(Boolean) as string[];
  return {
    ...(dur.length && { http_req_duration: dur }),
    ...(t.maxErrorRatePct !== undefined && { http_req_failed: [`rate<${t.maxErrorRatePct / 100}`] }),
    ...(t.minRps !== undefined && { http_reqs: [`rate>=${t.minRps}`] }),
  };
}

/**
 * k6 ramps linearly between stage targets; StepForge's stages hold a constant number of users, so each becomes a
 * 1 s jump followed by a hold.
 */
function k6Stages(stages: Stage[]) {
  return stages.flatMap((s) => [
    { duration: '1s', target: s.vus },
    ...(s.durationS > 1 ? [{ duration: `${s.durationS - 1}s`, target: s.vus }] : []),
  ]);
}

const OPTIONS_TRENDS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

/** Turns `{{scope.name}}` placeholders into k6 environment variables (secrets are never written into scripts). */
export function placeholderToEnv(expr: string): string {
  const [scope, ...rest] = expr.trim().split('.');
  const name = rest.join('_').replace(/[^A-Za-z0-9_]/g, '_');
  if (scope === 'env' && name === 'baseUrl') return 'BASE_URL';
  return `${(scope ?? 'VAR').toUpperCase()}_${name}`.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

/** A JS template literal for a value, with `{{…}}` placeholders read from __ENV. */
function templ(value: string, envs: Set<string>): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `\`${escaped.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const env = placeholderToEnv(expr);
    envs.add(env);
    // BASE_URL is a script constant (with the environment's URL as default); k6 does not keep writes to __ENV.
    return env === 'BASE_URL' ? '${BASE_URL}' : `\${__ENV.${env}}`;
  })}\``;
}

/**
 * A standalone k6 script for the same test: same stages, thresholds and requests. Requests keep their
 * `{{…}}` placeholders as environment variables (BASE_URL, SECRET_API_TOKEN…), listed in the header comment.
 */
export function toK6Script(config: {
  requests: { method: string; url: string; headers?: Record<string, string>; body?: string }[];
  profile: LoadProfile;
  vus: number;
  durationS: number;
  rampS?: number;
  thresholds?: LoadThresholds;
  name?: string;
  baseUrl?: string;
}): string {
  const envs = new Set<string>();
  const stages = k6Stages(planStages(config.profile, config.vus, config.durationS, config.rampS));
  const calls = config.requests.map((r) => {
    const params =
      r.headers && Object.keys(r.headers).length
        ? `, { headers: { ${Object.entries(r.headers)
            .map(([k, v]) => `${JSON.stringify(k)}: ${templ(v, envs)}`)
            .join(', ')} } }`
        : '';
    const body = r.body !== undefined && r.body !== '' ? templ(r.body, envs) : 'null';
    return `  res = http.request(${JSON.stringify(r.method.toUpperCase())}, ${templ(r.url, envs)}, ${body}${params});
  check(res, { ${JSON.stringify(`${r.method.toUpperCase()} status < 400`)}: (r) => r.status < 400 });`;
  });
  const options = {
    scenarios: { main: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '5s' } },
    thresholds: k6Thresholds(config.thresholds),
    summaryTrendStats: OPTIONS_TRENDS,
  };
  const envLines = [...envs].map(
    (e) => `//   ${e}${e === 'BASE_URL' && config.baseUrl ? ` (default ${config.baseUrl})` : ''}`,
  );
  return `// ${config.name ?? 'Load test'} — exported from StepForge (profile: ${config.profile}, ${config.vus} VUs).
// Run: k6 run script.js${envs.size ? `\n// Environment variables used:\n${envLines.join('\n')}` : ''}
import http from 'k6/http';
import { check } from 'k6';
${envs.has('BASE_URL') ? `\nconst BASE_URL = __ENV.BASE_URL || ${JSON.stringify(config.baseUrl ?? '')};\n` : ''}
export const options = ${JSON.stringify(options, null, 2)};

export default function () {
  let res;
${calls.join('\n')}
}
`;
}

/** Bridge script used when StepForge runs k6 itself: requests arrive via an env var, never written to disk. */
function bridgeScript(stages: Stage[], thresholds: LoadThresholds | undefined): string {
  return `import http from 'k6/http';
const REQUESTS = JSON.parse(__ENV.SF_REQUESTS);
export const options = ${JSON.stringify({
    scenarios: {
      main: { executor: 'ramping-vus', startVUs: 0, stages: k6Stages(stages), gracefulRampDown: '5s' },
    },
    thresholds: k6Thresholds(thresholds),
    summaryTrendStats: OPTIONS_TRENDS,
  })};
export default function () {
  for (const r of REQUESTS) http.request(r.method, r.url, r.body ?? null, { headers: r.headers ?? {}, tags: { name: r.method + ' ' + r.url.split('?')[0] } });
}
export function handleSummary(data) { return { [__ENV.SF_SUMMARY]: JSON.stringify(data) }; }
`;
}

/** Finds k6: an explicit path, STEPFORGE_K6_PATH, data/bin, then the PATH. */
export function findK6(opts: { binDir?: string; configuredPath?: string } = {}): string | null {
  const candidates = [
    opts.configuredPath,
    process.env.STEPFORGE_K6_PATH,
    opts.binDir && join(opts.binDir, exe),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((d) => join(d, exe)),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function k6Version(path: string): string | null {
  const r = spawnSync(path, ['version'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? (/k6 (v[\d.]+)/.exec(r.stdout)?.[1] ?? r.stdout.trim()) : null;
}

export function k6Asset(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
  if (!cpu || (os === 'windows' && cpu !== 'amd64'))
    throw new Error(`k6 has no build for ${platform}/${arch}`);
  return `k6-${K6_VERSION}-${os}-${cpu}.${os === 'linux' ? 'tar.gz' : 'zip'}`;
}

/** Downloads k6 (free, AGPL-3.0, run as a separate program) from its GitHub releases into `binDir`. */
export async function installK6(binDir: string): Promise<string> {
  const asset = k6Asset();
  const url = `https://github.com/grafana/k6/releases/download/${K6_VERSION}/${asset}`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  mkdirSync(binDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sf-k6-'));
  try {
    const archive = join(tmp, asset);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const r = spawnSync('tar', ['-xf', archive, '-C', tmp], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Could not extract ${asset}: ${r.stderr || r.error?.message}`);
    const target = join(binDir, exe);
    renameSync(join(tmp, asset.replace(/\.(zip|tar\.gz)$/, ''), exe), target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    return target;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

type K6Summary = {
  metrics: Record<string, { values: Record<string, number> } | undefined>;
  state?: { testRunDurationMs?: number };
};

/** Runs the same load test with k6 and converts its summary into a StepForge report. */
export async function runK6(
  k6Path: string,
  config: LoadConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<LoadReport> {
  validateLoadConfig(config);
  const stages = planStages(config.profile, config.vus, config.durationS, config.rampS);
  const dir = mkdtempSync(join(tmpdir(), 'sf-k6run-'));
  const script = join(dir, 'bridge.js');
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(script, bridgeScript(stages, config.thresholds));
  const startedAt = new Date();
  try {
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(k6Path, ['run', '--quiet', '--no-usage-report', script], {
        env: { ...process.env, SF_REQUESTS: JSON.stringify(config.requests), SF_SUMMARY: summaryPath },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let err = '';
      child.stderr?.on('data', (d) => (err = (err + String(d)).slice(-4000)));
      child.on('error', reject);
      child.on('exit', (c) => resolve({ code: c, stderr: err }));
      opts.signal?.addEventListener('abort', () => child.kill('SIGINT'), { once: true });
    });
    // 99 = thresholds failed (still a valid report).
    if (!existsSync(summaryPath))
      throw new Error(`k6 exited with code ${code}: ${stderr.trim() || 'no summary'}`);
    const s = JSON.parse(readFileSync(summaryPath, 'utf8')) as K6Summary;
    const d = s.metrics.http_req_duration?.values ?? {};
    const reqs = s.metrics.http_reqs?.values ?? {};
    const failed = s.metrics.http_req_failed?.values ?? {};
    const partial = {
      latency: {
        min: d.min ?? 0,
        avg: Math.round((d.avg ?? 0) * 100) / 100,
        p50: d.med ?? 0,
        p90: d['p(90)'] ?? 0,
        p95: d['p(95)'] ?? 0,
        p99: d['p(99)'] ?? 0,
        max: d.max ?? 0,
      },
      errorRatePct: Math.round((failed.rate ?? 0) * 10_000) / 100,
      rps: Math.round((reqs.rate ?? 0) * 100) / 100,
    };
    const thresholds = evaluateThresholds(partial, config.thresholds);
    return {
      engine: 'k6',
      profile: config.profile,
      vus: config.vus,
      durationS: stages.reduce((sum, x) => sum + x.durationS, 0),
      stages,
      target: describeTarget(config.requests),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      requests: reqs.count ?? 0,
      errors: failed.passes ?? 0,
      ...partial,
      statusCodes: {},
      timeline: [],
      thresholds,
      passed: !opts.signal?.aborted && thresholds.every((t) => t.passed),
      ...(opts.signal?.aborted && { cancelled: true }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
