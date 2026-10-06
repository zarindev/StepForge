import { STEPFORGE_VERSION, type RunScope } from '@stepforge/core';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { buildApp, type BuildOptions } from '@stepforge/server';
import { CREDIT } from '@stepforge/reports';
import { TARGETS } from '@stepforge/codegen';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Exit codes: 0 all passed, 1 tests failed (or the quality gate with --fail-on-gate), 2 usage or setup error. */
export const EXIT = { passed: 0, failed: 1, error: 2 } as const;

export type Io = { out: (s: string) => void; err: (s: string) => void };
const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

class UsageError extends Error {}

const HELP = `StepForge ${STEPFORGE_VERSION} — local-first QA studio (${CREDIT})

Usage: stepforge <command> [options]

Commands
  run       Run tests and wait for the result
  list      List applications, environments, modules, tags and schedules
  report    Write a report for a finished run
  export    Write an application as portable JSON (secrets are never included)
  import    Create an application from an export
  secret    Store an environment secret (encrypted), e.g. in CI after "import"
  codegen   Export tests as a ready-to-run project (Playwright, Cypress, Selenium, API, docs)

run
  --app <slug>          Application (required)
  --env <name>          Environment (required)
  --tag <name>          Only scenarios with this tag
  --module <name>       Only this module (and its sub-modules)
  --scenario <name>     Only these scenarios (repeatable)
  --browser <name>      chromium | firefox | webkit
  --workers <n>         Parallel tests (1–8)
  --retries <n>         Retries for failed tests (0–3)
  --headed              Show the browser
  --junit <file>        Write JUnit XML (for CI)
  --html <file>         Write the HTML report
  --pdf <file>          Write the PDF report
  --notify <channel>    Send the summary to a notification channel (repeatable)
  --fail-on-gate        Exit 1 when a blocking quality gate fails, even if all tests passed

report    --run <id> --format html|pdf|xlsx|junit --out <file>
export    --app <slug> --out <file>
import    --file <file> [--slug <new-slug>]
list      [--app <slug>]
secret    set --app <slug> --env <name> --key <NAME> (--from-env <VAR> | value on stdin)
codegen   --app <slug> --target <id> --out <dir> [--env <name>] [--tag|--module|--scenario]
          [--pom] [--ci github,gitlab]   (targets: stepforge codegen --list)

Global
  --data-dir <dir>      StepForge data folder (default: ./data or STEPFORGE_DATA_DIR)
  --json                Machine-readable output (run, list)
  -h, --help            This help
  -v, --version         Version

Exit codes: 0 passed · 1 failed · 2 usage or setup error`;

type Ctx = Awaited<ReturnType<typeof buildApp>>;

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a));

/** Runs one CLI command and returns the exit code. */
export async function main(argv: string[], io: Io = defaultIo, build: BuildOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || has(argv, '-h', '--help')) {
    io.out(HELP);
    return command ? EXIT.passed : EXIT.error;
  }
  if (has(argv, '-v', '--version')) {
    io.out(STEPFORGE_VERSION);
    return EXIT.passed;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    io.err(`Unknown command "${command}". Run "stepforge --help".`);
    return EXIT.error;
  }
  let values: Record<string, string | string[] | boolean | undefined>;
  try {
    // `secret set`: the action is the only positional argument.
    const positional = command === 'secret' ? rest.slice(0, 1) : [];
    if (command === 'secret' && positional[0] !== 'set') throw new Error('Usage: stepforge secret set …');
    ({ values } = parseArgs({
      args: rest.slice(positional.length),
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\nRun "stepforge --help".`);
    return EXIT.error;
  }
  let app: Ctx | undefined;
  try {
    app = await buildApp({
      ...build,
      embedded: true,
      config: {
        ...build.config,
        ...(typeof values['data-dir'] === 'string' && { dataDir: resolve(values['data-dir']) }),
      },
    });
    return await handler(app, values, io);
  } catch (err) {
    io.err(`Error: ${(err as Error).message}`);
    return EXIT.error;
  } finally {
    await app?.app.close();
  }
}

const OPTIONS = {
  app: { type: 'string' },
  env: { type: 'string' },
  tag: { type: 'string' },
  module: { type: 'string' },
  scenario: { type: 'string', multiple: true },
  browser: { type: 'string' },
  workers: { type: 'string' },
  retries: { type: 'string' },
  headed: { type: 'boolean' },
  junit: { type: 'string' },
  html: { type: 'string' },
  pdf: { type: 'string' },
  notify: { type: 'string', multiple: true },
  'fail-on-gate': { type: 'boolean' },
  run: { type: 'string' },
  format: { type: 'string' },
  out: { type: 'string' },
  file: { type: 'string' },
  slug: { type: 'string' },
  key: { type: 'string' },
  target: { type: 'string' },
  pom: { type: 'boolean' },
  ci: { type: 'string' },
  list: { type: 'boolean' },
  'from-env': { type: 'string' },
  'data-dir': { type: 'string' },
  json: { type: 'boolean' },
} as const;

type Values = Record<string, string | string[] | boolean | undefined>;
type Handler = (c: Ctx, v: Values, io: Io) => Promise<number>;

function need(v: Values, name: string): string {
  const x = v[name];
  if (typeof x !== 'string' || !x.trim()) throw new UsageError(`--${name} is required`);
  return x.trim();
}
const lc = (s: string) => s.trim().toLowerCase();

function findApp(c: Ctx, slug: string) {
  const a = repo.getApplicationBySlug(c.ctx.db, slug);
  if (!a) {
    const known = repo.listApplications(c.ctx.db).map((x) => x.slug);
    throw new UsageError(`No application "${slug}". Known: ${known.join(', ') || 'none'}`);
  }
  return a;
}

async function inject<T>(
  app: FastifyInstance,
  token: string,
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { host: '127.0.0.1', 'x-stepforge-token': token },
    ...(payload !== undefined && { payload: payload as object }),
  });
  if (res.statusCode >= 400) {
    const body = res.json() as { message?: string };
    throw new Error(body.message ?? `${method} ${url} failed (${res.statusCode})`);
  }
  return { body: res.rawPayload, json: () => res.json() as T };
}

function write(file: string, data: string | Buffer) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

const ICON: Record<string, string> = { passed: '✓', failed: '✗', broken: '!', skipped: '-', flaky: '~' };

const run: Handler = async (c, v, io) => {
  const { db } = c.ctx;
  const application = findApp(c, need(v, 'app'));
  const envName = need(v, 'env');
  const envs = repo.listEnvironments(db, application.id);
  const env = envs.find((e) => lc(e.name) === lc(envName));
  if (!env)
    throw new UsageError(
      `No environment "${envName}" in ${application.name}. Known: ${envs.map((e) => e.name).join(', ') || 'none'}`,
    );
  if (env.isProduction)
    io.err(`⚠ ${env.name} is a PRODUCTION environment. Tests run against ${env.baseUrl}.`);

  const filters = (['tag', 'module', 'scenario'] as const).filter((k) => v[k] !== undefined);
  if (filters.length > 1) throw new UsageError('Use only one of --tag, --module and --scenario');
  let scope: RunScope = { type: 'application' };
  if (typeof v.tag === 'string') {
    const tag = repo.listTags(db, application.id).find((t) => lc(t.name) === lc(v.tag as string));
    if (!tag) throw new UsageError(`No tag "${v.tag}" in ${application.name}`);
    scope = { type: 'tag', id: tag.id };
  } else if (typeof v.module === 'string') {
    const mod = repo.listModules(db, application.id).find((m) => lc(m.name) === lc(v.module as string));
    if (!mod) throw new UsageError(`No module "${v.module}" in ${application.name}`);
    scope = { type: 'module', id: mod.id };
  } else if (Array.isArray(v.scenario)) {
    const tree = repo.getTree(db, application.id);
    const ids = v.scenario.map((name) => {
      const s = tree.scenarios.find((x) => lc(x.name) === lc(name));
      if (!s) throw new UsageError(`No scenario "${name}" in ${application.name}`);
      return s.id;
    });
    scope = { type: 'scenarios', ids };
  }
  const channels = (Array.isArray(v.notify) ? v.notify : []).map((name) => {
    const ch = repo.listChannels(db).find((x) => lc(x.name) === lc(name));
    if (!ch) throw new UsageError(`No notification channel "${name}" (Settings → Notifications)`);
    return ch.id;
  });
  const num = (name: string) => {
    if (typeof v[name] !== 'string') return undefined;
    const n = Number(v[name]);
    if (!Number.isInteger(n)) throw new UsageError(`--${name} must be a whole number`);
    return n;
  };
  const options = {
    ...(typeof v.browser === 'string' && { browser: v.browser }),
    ...(num('workers') !== undefined && { workers: num('workers') }),
    ...(num('retries') !== undefined && { retries: num('retries') }),
    ...(v.headed && { headed: true }),
  };

  const json = v.json === true;
  const onEvent = (e: { type: string; runId?: string; item?: typeof schema.runItems.$inferSelect }) => {
    if (json || e.type !== 'item.updated' || e.runId !== runId || !e.item) return;
    const i = e.item;
    if (!ICON[i.status]) return;
    const label = [i.labelJson?.scenario, i.labelJson?.testCaseCode].filter(Boolean).join(' — ');
    const ms = i.durationMs !== null ? ` (${(i.durationMs / 1000).toFixed(1)} s)` : '';
    io.out(
      `  ${ICON[i.status]} ${label}${ms}${i.status === 'failed' || i.status === 'broken' ? `\n      ${(i.errorMessage ?? '').split('\n')[0]}` : ''}`,
    );
  };
  let runId = '';
  c.ctx.bus.on('event', onEvent);
  let created;
  try {
    created = c.ctx.runs.create({
      applicationId: application.id,
      environmentId: env.id,
      scope,
      options: options as never,
      trigger: 'cli',
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  runId = created.id;
  if (!json)
    io.out(
      `Running ${application.name} · ${env.name} (${created.totalsJson?.total ?? '?'} tests, run ${runId})`,
    );

  // Ctrl+C cancels the run cleanly instead of leaving it "running".
  const cancel = () => {
    io.err('\nCancelling…');
    c.ctx.runs.cancel(runId);
  };
  process.once('SIGINT', cancel);
  try {
    await c.ctx.runs.idle();
  } finally {
    process.off('SIGINT', cancel);
    c.ctx.bus.off('event', onEvent);
  }

  const final = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
  const gate = final.qualityGateJson as { status: string; blocking?: boolean } | null;
  const t = final.totalsJson as {
    total: number;
    passed: number;
    failed: number;
    broken: number;
    skipped: number;
    flaky: number;
  };

  const files: string[] = [];
  const token = c.ctx.token;
  for (const [flag, format] of [
    ['junit', 'junit'],
    ['html', 'html'],
    ['pdf', 'pdf'],
  ] as const) {
    if (typeof v[flag] !== 'string') continue;
    const r = await inject(c.app, token, 'GET', `/api/runs/${runId}/report?format=${format}`);
    files.push(write(v[flag] as string, r.body));
  }
  const notified = channels.length ? await c.ctx.scheduler.notifyRun(runId, channels) : [];

  const failedGate = gate?.status === 'red';
  const code = final.status === 'passed' && !(v['fail-on-gate'] && failedGate) ? EXIT.passed : EXIT.failed;
  if (json) {
    io.out(
      JSON.stringify(
        {
          runId,
          status: final.status,
          totals: t,
          qualityGate: gate?.status ?? null,
          files,
          notifications: notified,
          exitCode: code,
        },
        null,
        2,
      ),
    );
    return code;
  }
  io.out('');
  io.out(
    `${final.status === 'passed' ? 'PASSED' : final.status.toUpperCase()}: ${t.passed}/${t.total} passed` +
      `${t.failed ? `, ${t.failed} failed` : ''}${t.broken ? `, ${t.broken} broken` : ''}${t.flaky ? `, ${t.flaky} flaky` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}` +
      ` in ${((final.durationMs ?? 0) / 1000).toFixed(1)} s`,
  );
  if (gate) io.out(`Quality gate: ${gate.status}`);
  for (const f of files) io.out(`Wrote ${f}`);
  for (const n of notified)
    io.out(
      n.ok
        ? `${n.skipped ? 'Skipped' : 'Sent'} summary to ${n.channel}`
        : `Could not notify ${n.channel}: ${n.error}`,
    );
  return code;
};

const list: Handler = async (c, v, io) => {
  const { db } = c.ctx;
  const apps = typeof v.app === 'string' ? [findApp(c, v.app)] : repo.listApplications(c.ctx.db);
  const data = apps.map((a) => ({
    slug: a.slug,
    name: a.name,
    environments: repo
      .listEnvironments(db, a.id)
      .map((e) => ({ name: e.name, baseUrl: e.baseUrl, production: e.isProduction })),
    modules: repo.listModules(db, a.id).map((m) => m.name),
    tags: repo.listTags(db, a.id).map((t) => t.name),
    scenarios: repo.getTree(db, a.id).scenarios.length,
    schedules: repo.listSchedules(db, a.id).map((s) => ({ name: s.name, cron: s.cron, enabled: s.enabled })),
  }));
  if (v.json) {
    io.out(
      JSON.stringify({ applications: data, channels: repo.listChannels(db).map((ch) => ch.name) }, null, 2),
    );
    return EXIT.passed;
  }
  if (!data.length)
    io.out('No applications yet. Create one in the StepForge dashboard or with "stepforge import".');
  for (const a of data) {
    io.out(`${a.name} (--app ${a.slug}) · ${a.scenarios} scenarios`);
    for (const e of a.environments)
      io.out(`  env     ${e.name}${e.production ? ' [PRODUCTION]' : ''}  ${e.baseUrl}`);
    if (a.modules.length) io.out(`  modules ${a.modules.join(', ')}`);
    if (a.tags.length) io.out(`  tags    ${a.tags.join(', ')}`);
    for (const s of a.schedules) io.out(`  schedule ${s.name}  "${s.cron}"${s.enabled ? '' : ' (off)'}`);
  }
  const channels = repo.listChannels(db);
  if (channels.length) io.out(`Notification channels: ${channels.map((ch) => ch.name).join(', ')}`);
  return EXIT.passed;
};

const report: Handler = async (c, v, io) => {
  const id = need(v, 'run');
  const format = need(v, 'format');
  if (!['html', 'pdf', 'xlsx', 'junit'].includes(format))
    throw new UsageError('--format must be html, pdf, xlsx or junit');
  const out = need(v, 'out');
  const r = await inject(c.app, c.ctx.token, 'GET', `/api/runs/${id}/report?format=${format}`);
  io.out(`Wrote ${write(out, r.body)}`);
  return EXIT.passed;
};

const exportCmd: Handler = async (c, v, io) => {
  const a = findApp(c, need(v, 'app'));
  const data = repo.exportApplication(c.ctx.db, a.id, `StepForge ${STEPFORGE_VERSION} CLI · ${CREDIT}`);
  const path = write(need(v, 'out'), `${JSON.stringify(data, null, 2)}\n`);
  io.out(
    `Wrote ${path} (${data.scenarios.length} scenarios, ${data.environments.length} environments; secrets not included)`,
  );
  return EXIT.passed;
};

const importCmd: Handler = async (c, v, io) => {
  const file = need(v, 'file');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  const r = repo.importApplication(c.ctx.db, data, { slug: typeof v.slug === 'string' ? v.slug : undefined });
  io.out(
    `Imported "${r.slug}": ${r.counts.environments} environments, ${r.counts.modules} modules, ${r.counts.scenarios} scenarios, ${r.counts.testCases} test cases, ${r.counts.blocks} blocks`,
  );
  for (const m of r.missingSecrets)
    io.out(`  Enter these secrets again in ${m.environment}: ${m.keys.join(', ')}`);
  return EXIT.passed;
};

/** Never takes the value as an argument: it would end up in shell history and process lists. */
const secretCmd: Handler = async (c, v, io) => {
  const application = findApp(c, need(v, 'app'));
  const envName = need(v, 'env');
  const env = repo.listEnvironments(c.ctx.db, application.id).find((e) => lc(e.name) === lc(envName));
  if (!env) throw new UsageError(`No environment "${envName}" in ${application.name}`);
  const key = need(v, 'key');
  let value: string | undefined;
  if (typeof v['from-env'] === 'string') {
    value = process.env[v['from-env']];
    if (value === undefined) throw new UsageError(`The environment variable ${v['from-env']} is not set`);
  } else {
    if (process.stdin.isTTY) throw new UsageError('Pass --from-env <VAR> or pipe the value on stdin');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    value = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  if (!value) throw new UsageError('The secret value is empty');
  repo.setSecret(c.ctx.db, c.ctx.masterKey, env.id, { key, value });
  io.out(`Stored secret ${key} in ${application.name} · ${env.name} (encrypted)`);
  return EXIT.passed;
};

const codegenCmd: Handler = async (c, v, io) => {
  if (v.list) {
    for (const t of TARGETS)
      io.out(`${t.id.padEnd(16)} ${t.label} (${t.language})${t.pom ? ' · --pom' : ''}`);
    return EXIT.passed;
  }
  const { db } = c.ctx;
  const application = findApp(c, need(v, 'app'));
  const target = need(v, 'target');
  if (!TARGETS.some((t) => t.id === target))
    throw new UsageError(`Unknown target "${target}". Run "stepforge codegen --list".`);
  const out = resolve(need(v, 'out'));
  let environmentId: string | undefined;
  if (typeof v.env === 'string') {
    const env = repo.listEnvironments(db, application.id).find((e) => lc(e.name) === lc(v.env as string));
    if (!env) throw new UsageError(`No environment "${v.env}" in ${application.name}`);
    environmentId = env.id;
  }
  const filters = (['tag', 'module', 'scenario'] as const).filter((k) => v[k] !== undefined);
  if (filters.length > 1) throw new UsageError('Use only one of --tag, --module and --scenario');
  let scope: Record<string, unknown> = { type: 'application' };
  if (typeof v.tag === 'string') {
    const tag = repo.listTags(db, application.id).find((t) => lc(t.name) === lc(v.tag as string));
    if (!tag) throw new UsageError(`No tag "${v.tag}" in ${application.name}`);
    scope = { type: 'tag', id: tag.id };
  } else if (typeof v.module === 'string') {
    const mod = repo.listModules(db, application.id).find((m) => lc(m.name) === lc(v.module as string));
    if (!mod) throw new UsageError(`No module "${v.module}" in ${application.name}`);
    scope = { type: 'module', id: mod.id };
  } else if (Array.isArray(v.scenario)) {
    const tree = repo.getTree(db, application.id);
    scope = {
      type: 'scenarios',
      ids: v.scenario.map((name) => {
        const s = tree.scenarios.find((x) => lc(x.name) === lc(name));
        if (!s) throw new UsageError(`No scenario "${name}" in ${application.name}`);
        return s.id;
      }),
    };
  }
  const { project } = await c.ctx.codegen.build(application.id, {
    target,
    environmentId,
    scope,
    pom: !!v.pom,
    ci:
      typeof v.ci === 'string'
        ? v.ci
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [],
  });
  for (const [path, content] of Object.entries(project.files)) write(join(out, path), content);
  io.out(`Wrote ${Object.keys(project.files).length} files to ${out}`);
  for (const w of project.warnings)
    io.out(`  ⚠ ${w.scenario ? `${w.scenario} — ` : ''}${w.step ? `${w.step}: ` : ''}${w.message}`);
  io.out(`Run it: cd ${out} && ${project.run}`);
  return EXIT.passed;
};

const COMMANDS: Record<string, Handler> = {
  codegen: wrap(codegenCmd),
  secret: wrap(secretCmd),
  run: wrap(run),
  list: wrap(list),
  report: wrap(report),
  export: wrap(exportCmd),
  import: wrap(importCmd),
};

/** Usage errors print a hint; everything else is reported by main(). */
function wrap(h: Handler): Handler {
  return async (c, v, io) => {
    try {
      return await h(c, v, io);
    } catch (err) {
      if (err instanceof UsageError || (err as Error).name === 'RepoError') {
        io.err(`Error: ${(err as Error).message}`);
        return EXIT.error;
      }
      throw err;
    }
  };
}
