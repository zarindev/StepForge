import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * StepForge's own data model (Section 6). All IDs are ULIDs, timestamps are ISO-8601 strings.
 * JSON columns are stored as TEXT and validated with Zod at the repository boundary.
 */

const id = () => text('id').primaryKey();
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();
const bool = (name: string) => integer(name, { mode: 'boolean' });
const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
};
const fk = (name: string, ref: () => AnySQLiteColumn, onDelete: 'cascade' | 'set null' = 'cascade') =>
  text(name).references(ref, { onDelete });

// ─── Workspace and applications ────────────────────────────────────────────

export const applications = sqliteTable('applications', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default('app-window'),
  color: text('color').notNull().default('#F97316'),
  category: text('category').notNull().default('web'),
  tagsJson: json<string[]>('tags_json').notNull().default([]),
  archived: bool('archived').notNull().default(false),
  ...timestamps,
});

export const environments = sqliteTable(
  'environments',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    isProduction: bool('is_production').notNull().default(false),
    variablesJson: json<Record<string, string>>('variables_json').notNull().default({}),
    browserDefaultsJson: json<Record<string, unknown>>('browser_defaults_json').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('environments_app_idx').on(t.applicationId)],
);

export const secrets = sqliteTable(
  'secrets',
  {
    id: id(),
    environmentId: fk('environment_id', () => environments.id),
    key: text('key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('secrets_env_key_uq').on(t.environmentId, t.key)],
);

export const dbConnections = sqliteTable(
  'db_connections',
  {
    id: id(),
    environmentId: fk('environment_id', () => environments.id).notNull(),
    name: text('name').notNull(),
    engine: text('engine', { enum: ['pg', 'mysql', 'mssql', 'sqlite', 'mongo'] }).notNull(),
    host: text('host').notNull().default(''),
    port: integer('port'),
    database: text('database').notNull().default(''),
    username: text('username').notNull().default(''),
    secretId: fk('secret_id', () => secrets.id, 'set null'),
    optionsJson: json<Record<string, unknown>>('options_json').notNull().default({}),
    readOnly: bool('read_only').notNull().default(true),
    rollbackMode: bool('rollback_mode').notNull().default(true),
    ...timestamps,
  },
  // Steps refer to connections by name, so a name is unique within its environment.
  (t) => [uniqueIndex('db_connections_env_name_uq').on(t.environmentId, t.name)],
);

export const mailInboxes = sqliteTable(
  'mail_inboxes',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    /** Email steps refer to an inbox by name. */
    name: text('name').notNull().default('Inbox'),
    kind: text('kind', { enum: ['mailpit', 'imap'] }).notNull(),
    configJson: json<Record<string, unknown>>('config_json').notNull().default({}),
    secretId: fk('secret_id', () => secrets.id, 'set null'),
    ...timestamps,
  },
  (t) => [uniqueIndex('mail_inboxes_app_name_uq').on(t.applicationId, t.name)],
);

export const apiSpecs = sqliteTable('api_specs', {
  id: id(),
  applicationId: fk('application_id', () => applications.id).notNull(),
  name: text('name').notNull(),
  source: text('source', { enum: ['openapi', 'postman', 'har'] }).notNull(),
  rawPath: text('raw_path').notNull(),
  parsedJson: json<unknown>('parsed_json'),
  version: text('version').notNull().default(''),
  ...timestamps,
});

// ─── Test organisation ─────────────────────────────────────────────────────

export const modules = sqliteTable(
  'modules',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    // Self reference declared without .references() to avoid a circular type; enforced in the repo layer.
    parentId: text('parent_id'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Hooks: a block run before / after every test in this module and its sub-modules (blocks.ts clears them). */
    setupBlockId: text('setup_block_id'),
    teardownBlockId: text('teardown_block_id'),
    ...timestamps,
  },
  (t) => [index('modules_app_idx').on(t.applicationId), index('modules_parent_idx').on(t.parentId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6366F1'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_app_name_uq').on(t.applicationId, t.name)],
);

/** An input a block declares; each `util.useBlock` passes a value (or the default) as `{{vars.<name>}}`. */
export type BlockInputDef = { name: string; default?: string; description?: string };

export const blocks = sqliteTable('blocks', {
  id: id(),
  applicationId: fk('application_id', () => applications.id).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  inputsJson: json<BlockInputDef[]>('inputs_json').notNull().default([]),
  ...timestamps,
});

/** A named UI element ("Save patient button") shared by steps: fix its locators once, every step follows. */
export const elements = sqliteTable(
  'elements',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    name: text('name').notNull(),
    /** Optional grouping, e.g. the page or screen it belongs to. */
    page: text('page').notNull().default(''),
    description: text('description').notNull().default(''),
    /** Ranked locators, best first (same shape as a step's locators). */
    locatorsJson: json<Record<string, unknown>[]>('locators_json').notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('elements_app_name_uq').on(t.applicationId, t.name)],
);

export const scenarios = sqliteTable(
  'scenarios',
  {
    id: id(),
    moduleId: fk('module_id', () => modules.id).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind', { enum: ['ui', 'api', 'db', 'email', 'perf', 'hybrid'] })
      .notNull()
      .default('ui'),
    priority: text('priority', { enum: ['P1', 'P2', 'P3', 'P4'] })
      .notNull()
      .default('P2'),
    status: text('status', { enum: ['draft', 'ready', 'deprecated'] })
      .notNull()
      .default('draft'),
    owner: text('owner').notNull().default(''),
    preconditions: text('preconditions').notNull().default(''),
    version: integer('version').notNull().default(1),
    setupBlockId: fk('setup_block_id', () => blocks.id, 'set null'),
    teardownBlockId: fk('teardown_block_id', () => blocks.id, 'set null'),
    /** automated: StepForge runs it (and schedules do); manual: a person runs it, pending until they do. */
    execution: text('execution', { enum: ['automated', 'manual'] })
      .notNull()
      .default('automated'),
    ...timestamps,
  },
  (t) => [index('scenarios_module_idx').on(t.moduleId)],
);

export const scenarioTags = sqliteTable(
  'scenario_tags',
  {
    scenarioId: fk('scenario_id', () => scenarios.id).notNull(),
    tagId: fk('tag_id', () => tags.id).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scenarioId, t.tagId] })],
);

const stepColumns = {
  position: integer('position').notNull(),
  type: text('type').notNull(),
  label: text('label').notNull().default(''),
  paramsJson: json<Record<string, unknown>>('params_json').notNull().default({}),
  locatorsJson: json<unknown[]>('locators_json').notNull().default([]),
  assertionsJson: json<unknown[]>('assertions_json').notNull().default([]),
  enabled: bool('enabled').notNull().default(true),
  continueOnFail: bool('continue_on_fail').notNull().default(false),
  timeoutMs: integer('timeout_ms'),
  retries: integer('retries').notNull().default(0),
  captureAs: text('capture_as'),
};

export const steps = sqliteTable(
  'steps',
  { id: id(), scenarioId: fk('scenario_id', () => scenarios.id).notNull(), ...stepColumns, ...timestamps },
  (t) => [index('steps_scenario_idx').on(t.scenarioId, t.position)],
);

export const blockSteps = sqliteTable(
  'block_steps',
  { id: id(), blockId: fk('block_id', () => blocks.id).notNull(), ...stepColumns, ...timestamps },
  (t) => [index('block_steps_block_idx').on(t.blockId, t.position)],
);

export const testCases = sqliteTable(
  'test_cases',
  {
    id: id(),
    scenarioId: fk('scenario_id', () => scenarios.id).notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    dataJson: json<Record<string, unknown>>('data_json').notNull().default({}),
    expectedResult: text('expected_result').notNull().default(''),
    priority: text('priority', { enum: ['P1', 'P2', 'P3', 'P4'] })
      .notNull()
      .default('P2'),
    technique: text('technique').notNull().default('positive'),
    status: text('status', { enum: ['active', 'skipped'] })
      .notNull()
      .default('active'),
    ...timestamps,
  },
  (t) => [index('test_cases_scenario_idx').on(t.scenarioId)],
);

/**
 * The test data library: named data sources a test reads rows from with `util.useData`. `table` keeps its rows here;
 * `csv` reads a file, `sql` runs a read-only query on one of the application's connections, `api` calls an endpoint
 * (all at run time, once per run).
 */
export const datasets = sqliteTable(
  'datasets',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['table', 'csv', 'sql', 'api'] })
      .notNull()
      .default('table'),
    description: text('description').notNull().default(''),
    /** csv: { path }; sql: { connection, query }; api: { method, url, headers, rowsPath }. */
    configJson: json<Record<string, unknown>>('config_json').notNull().default({}),
    columnsJson: json<string[]>('columns_json').notNull().default([]),
    rowsJson: json<Record<string, unknown>[]>('rows_json').notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('datasets_app_name_uq').on(t.applicationId, t.name)],
);

export const scenarioVersions = sqliteTable(
  'scenario_versions',
  {
    id: id(),
    scenarioId: fk('scenario_id', () => scenarios.id).notNull(),
    version: integer('version').notNull(),
    snapshotJson: json<unknown>('snapshot_json').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('scenario_versions_uq').on(t.scenarioId, t.version)],
);

// ─── Execution ─────────────────────────────────────────────────────────────

export const runs = sqliteTable(
  'runs',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    environmentId: fk('environment_id', () => environments.id, 'set null'),
    trigger: text('trigger', { enum: ['manual', 'schedule', 'cli', 'retry'] })
      .notNull()
      .default('manual'),
    scopeJson: json<Record<string, unknown>>('scope_json').notNull().default({}),
    browser: text('browser').notNull().default('chromium'),
    viewport: text('viewport').notNull().default('desktop'),
    workers: integer('workers').notNull().default(1),
    optionsJson: json<Record<string, unknown>>('options_json').notNull().default({}),
    status: text('status', {
      enum: ['queued', 'running', 'passed', 'failed', 'interrupted', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    totalsJson: json<Record<string, number>>('totals_json').notNull().default({}),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    qualityGateJson: json<unknown>('quality_gate_json'),
    /** Set for runs started by a schedule (schedule history). */
    scheduleId: text('schedule_id'),
    /** Set for the runs of a campaign run (one per environment × browser × screen size). */
    campaignRunId: text('campaign_run_id'),
    /** auto: StepForge executes the steps; manual: a person does them and records each step's result. */
    mode: text('mode', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    /** Queue order: higher runs first (high 1, normal 0, low -1; "Run next" goes above all), then oldest first. */
    priority: integer('priority').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('runs_app_idx').on(t.applicationId, t.createdAt),
    index('runs_status_idx').on(t.status),
    index('runs_campaign_run_idx').on(t.campaignRunId),
  ],
);

/**
 * A saved test campaign: which tests (whole application, or modules / tags / scenarios) across which
 * environments × browsers × screen sizes, with run options and notification channels.
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** `{ all: true }` or `{ modules: [], tags: [], scenarios: [] }` (union). */
    selectionJson: json<Record<string, unknown>>('selection_json').notNull().default({ all: true }),
    environmentIdsJson: json<string[]>('environment_ids_json').notNull().default([]),
    browsersJson: json<string[]>('browsers_json').notNull().default(['chromium']),
    viewportsJson: json<string[]>('viewports_json').notNull().default(['desktop']),
    optionsJson: json<Record<string, unknown>>('options_json').notNull().default({}),
    notifyChannelIdsJson: json<string[]>('notify_channel_ids_json').notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('campaigns_app_name_uq').on(t.applicationId, t.name)],
);

/** One execution of a campaign: a group of runs. Its status is derived from them. */
export const campaignRuns = sqliteTable(
  'campaign_runs',
  {
    id: id(),
    campaignId: fk('campaign_id', () => campaigns.id).notNull(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    trigger: text('trigger', { enum: ['manual', 'schedule', 'cli', 'rerun'] })
      .notNull()
      .default('manual'),
    /** For "rerun failed": the campaign run whose failures this one repeats. */
    parentId: text('parent_id'),
    scheduleId: text('schedule_id'),
    /** Set once all runs finished and the summary was sent. */
    finishedAt: text('finished_at'),
    ...timestamps,
  },
  (t) => [index('campaign_runs_campaign_idx').on(t.campaignId, t.createdAt)],
);

export const runItems = sqliteTable(
  'run_items',
  {
    id: id(),
    runId: fk('run_id', () => runs.id).notNull(),
    testCaseId: fk('test_case_id', () => testCases.id, 'set null'),
    scenarioId: fk('scenario_id', () => scenarios.id, 'set null'),
    /** Snapshot of names at run time so history stays readable after edits or deletes. */
    labelJson: json<{
      scenario: string;
      modulePath: string[];
      testCaseCode: string | null;
      testCaseTitle: string | null;
    }>('label_json'),
    position: integer('position').notNull().default(0),
    scenarioVersion: integer('scenario_version').notNull().default(1),
    status: text('status', { enum: ['queued', 'running', 'passed', 'failed', 'broken', 'skipped', 'flaky'] })
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(1),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
    failedStepId: text('failed_step_id'),
    diagnosisJson: json<unknown>('diagnosis_json'),
    ...timestamps,
  },
  (t) => [
    index('run_items_run_idx').on(t.runId),
    index('run_items_tc_idx').on(t.testCaseId),
    index('run_items_scenario_idx').on(t.scenarioId),
  ],
);

export const stepResults = sqliteTable(
  'step_results',
  {
    id: id(),
    runItemId: fk('run_item_id', () => runItems.id).notNull(),
    stepId: text('step_id'),
    position: integer('position').notNull(),
    type: text('type').notNull().default(''),
    label: text('label').notNull().default(''),
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    message: text('message'),
    requestJson: json<unknown>('request_json'),
    responseJson: json<unknown>('response_json'),
    queryJson: json<unknown>('query_json'),
    screenshotPath: text('screenshot_path'),
    ...timestamps,
  },
  (t) => [index('step_results_item_idx').on(t.runItemId, t.position)],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: id(),
    runItemId: fk('run_item_id', () => runItems.id).notNull(),
    kind: text('kind', {
      enum: [
        'video',
        'trace',
        'screenshot',
        'har',
        'console',
        'network',
        'email',
        'lighthouse',
        'load_report',
        'dom',
      ],
    }).notNull(),
    path: text('path').notNull(),
    size: integer('size').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('artifacts_item_idx').on(t.runItemId)],
);

export const perfMetrics = sqliteTable('perf_metrics', {
  id: id(),
  runItemId: fk('run_item_id', () => runItems.id).notNull(),
  stepId: text('step_id'),
  metric: text('metric').notNull(),
  value: real('value').notNull(),
  unit: text('unit').notNull().default('ms'),
  threshold: real('threshold'),
  passed: bool('passed'),
  ...timestamps,
});

export const loadResults = sqliteTable('load_results', {
  id: id(),
  runItemId: fk('run_item_id', () => runItems.id).notNull(),
  profile: text('profile').notNull(),
  vus: integer('vus').notNull(),
  durationS: integer('duration_s').notNull(),
  rps: real('rps').notNull(),
  p50: real('p50'),
  p90: real('p90'),
  p95: real('p95'),
  p99: real('p99'),
  errorRate: real('error_rate').notNull().default(0),
  timelinePath: text('timeline_path'),
  ...timestamps,
});

// ─── Quality and automation ────────────────────────────────────────────────

export const bugs = sqliteTable(
  'bugs',
  {
    id: id(),
    applicationId: fk('application_id', () => applications.id).notNull(),
    runItemId: fk('run_item_id', () => runItems.id, 'set null'),
    code: text('code').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    severity: text('severity', { enum: ['critical', 'major', 'minor', 'trivial'] })
      .notNull()
      .default('major'),
    priority: text('priority', { enum: ['P1', 'P2', 'P3', 'P4'] })
      .notNull()
      .default('P2'),
    status: text('status', { enum: ['open', 'in_progress', 'fixed', 'wont_fix', 'duplicate'] })
      .notNull()
      .default('open'),
    environmentJson: json<Record<string, unknown>>('environment_json').notNull().default({}),
    preconditions: text('preconditions').notNull().default(''),
    stepsToReproduceJson: json<string[]>('steps_to_reproduce_json').notNull().default([]),
    expected: text('expected').notNull().default(''),
    actual: text('actual').notNull().default(''),
    diagnosisJson: json<unknown>('diagnosis_json'),
    ownerHint: text('owner_hint', { enum: ['test', 'app', 'environment', 'data'] }),
    fingerprint: text('fingerprint').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    /** Kept even when the run that found it is deleted. */
    scenarioId: fk('scenario_id', () => scenarios.id, 'set null'),
    testCaseId: fk('test_case_id', () => testCases.id, 'set null'),
    failedStepId: text('failed_step_id'),
    category: text('category'),
    lastSeenAt: text('last_seen_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bugs_app_code_uq').on(t.applicationId, t.code),
    index('bugs_fingerprint_idx').on(t.applicationId, t.fingerprint),
  ],
);

export const notifyChannels = sqliteTable('notify_channels', {
  id: id(),
  name: text('name').notNull().default(''),
  kind: text('kind', { enum: ['telegram', 'email', 'slack', 'teams', 'webhook'] }).notNull(),
  configJson: json<Record<string, unknown>>('config_json').notNull().default({}),
  secretId: fk('secret_id', () => secrets.id, 'set null'),
  ...timestamps,
});

export const schedules = sqliteTable('schedules', {
  id: id(),
  applicationId: fk('application_id', () => applications.id).notNull(),
  environmentId: fk('environment_id', () => environments.id, 'set null'),
  name: text('name').notNull(),
  cron: text('cron').notNull(),
  scopeJson: json<Record<string, unknown>>('scope_json').notNull().default({}),
  enabled: bool('enabled').notNull().default(true),
  notifyChannelIdsJson: json<string[]>('notify_channel_ids_json').notNull().default([]),
  /** Run options (browser, workers, retries…) used for each scheduled run. */
  optionsJson: json<Record<string, unknown>>('options_json').notNull().default({}),
  lastRunId: text('last_run_id'),
  nextRunAt: text('next_run_at'),
  /** When set, the schedule runs this campaign (its environments, browsers and sizes) instead of one run. */
  campaignId: fk('campaign_id', () => campaigns.id, 'cascade'),
  ...timestamps,
});

export const qualityGates = sqliteTable('quality_gates', {
  id: id(),
  applicationId: fk('application_id', () => applications.id).notNull(),
  name: text('name').notNull(),
  rulesJson: json<unknown[]>('rules_json').notNull().default([]),
  ...timestamps,
});

export const exportsTable = sqliteTable('exports', {
  id: id(),
  applicationId: fk('application_id', () => applications.id).notNull(),
  kind: text('kind').notNull(),
  optionsJson: json<Record<string, unknown>>('options_json').notNull().default({}),
  path: text('path').notNull(),
  ...timestamps,
});

export const analyticsDaily = sqliteTable(
  'analytics_daily',
  {
    applicationId: fk('application_id', () => applications.id).notNull(),
    date: text('date').notNull(),
    runs: integer('runs').notNull().default(0),
    tests: integer('tests').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    flaky: integer('flaky').notNull().default(0),
    avgDurationMs: integer('avg_duration_ms').notNull().default(0),
    p95ApiMs: real('p95_api_ms'),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.date] })],
);

export const loadTestAuthorizations = sqliteTable('load_test_authorizations', {
  id: id(),
  applicationId: fk('application_id', () => applications.id)
    .notNull()
    .unique(),
  confirmedText: text('confirmed_text').notNull(),
  ...timestamps,
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: json<unknown>('value_json').notNull(),
  ...timestamps,
});
