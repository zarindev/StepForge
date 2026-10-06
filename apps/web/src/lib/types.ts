import type { Assertion, Locator, Priority, ScenarioKind } from '@stepforge/core';

/** Shapes returned by the StepForge API (kept in sync with packages/db/src/repos). */

export type Application = {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  color: string;
  category: string;
  tagsJson: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  hasProduction: boolean;
  counts: {
    environments: number;
    modules: number;
    scenarios: number;
    testCases: number;
    runs: number;
    openBugs: number;
  };
};

export type Environment = {
  id: string;
  applicationId: string;
  name: string;
  baseUrl: string;
  isProduction: boolean;
  variablesJson: Record<string, string>;
  browserDefaultsJson: Record<string, unknown>;
  updatedAt: string;
};

export type SecretMeta = { id: string; environmentId: string; key: string; updatedAt: string };
export type Tag = { id: string; applicationId: string; name: string; color: string };

export type ModuleNode = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  sortOrder: number;
};
export type ScenarioStatus = 'draft' | 'ready' | 'deprecated';
export type ScenarioSummary = {
  id: string;
  moduleId: string;
  name: string;
  kind: ScenarioKind;
  priority: Priority;
  status: ScenarioStatus;
  owner: string;
  version: number;
  tagIds: string[];
  stepCount: number;
};
export type TestCaseSummary = {
  id: string;
  scenarioId: string;
  code: string;
  title: string;
  status: 'active' | 'skipped';
  priority: Priority;
  technique: string;
};
export type Tree = { modules: ModuleNode[]; scenarios: ScenarioSummary[]; testCases: TestCaseSummary[] };

export type StepRecord = {
  id?: string;
  type: string;
  label?: string;
  params: Record<string, unknown>;
  locators: Locator[];
  assertions: Assertion[];
  enabled: boolean;
  continueOnFail: boolean;
  timeoutMs?: number;
  retries: number;
  captureAs?: string;
};

export type TestCase = TestCaseSummary & { dataJson: Record<string, unknown>; expectedResult: string };

export type ScenarioDetail = Omit<ScenarioSummary, 'tagIds' | 'stepCount'> & {
  applicationId: string;
  description: string;
  preconditions: string;
  steps: StepRecord[];
  testCases: TestCase[];
  tagIds: string[];
  updatedAt: string;
};

export type ScenarioSnapshot = {
  name: string;
  description: string;
  priority: Priority;
  status: ScenarioStatus;
  owner: string;
  preconditions: string;
  steps: StepRecord[];
  restoredFrom?: number;
  note?: string;
};
export type ScenarioVersion = {
  id: string;
  version: number;
  snapshotJson: ScenarioSnapshot;
  createdAt: string;
};

export type SearchHit = {
  kind: 'application' | 'scenario' | 'testCase';
  id: string;
  title: string;
  subtitle: string;
  applicationId: string;
  scenarioId?: string;
};

// ─── Runs (Phase 3) ────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'interrupted' | 'cancelled';
export type ItemStatus = 'queued' | 'running' | 'passed' | 'failed' | 'broken' | 'skipped' | 'flaky';
export type Totals = {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  flaky: number;
};
export type RunOptionsForm = {
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport: 'desktop' | 'tablet' | 'mobile';
  headed: boolean;
  workers: number;
  retries: number;
  stopOnFirstFailure: boolean;
  video: 'off' | 'onFailure' | 'always';
  trace: 'off' | 'onFailure' | 'always';
  screenshots: 'off' | 'onFailure' | 'everyStep';
};
export type RunScope =
  | { type: 'application' }
  | { type: 'module'; id: string }
  | { type: 'scenarios'; ids: string[] }
  | { type: 'testCases'; ids: string[] }
  | { type: 'tag'; id: string };

export type Run = {
  id: string;
  applicationId: string;
  environmentId: string | null;
  trigger: string;
  scopeJson: RunScope;
  browser: string;
  viewport: string;
  workers: number;
  optionsJson: RunOptionsForm;
  status: RunStatus;
  totalsJson: Totals;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
};
export type RunListRow = Run & {
  applicationName: string;
  applicationColor: string;
  environmentName: string | null;
};

export type RunItem = {
  id: string;
  runId: string;
  testCaseId: string | null;
  scenarioId: string | null;
  labelJson: {
    scenario: string;
    modulePath: string[];
    testCaseCode: string | null;
    testCaseTitle: string | null;
  } | null;
  position: number;
  scenarioVersion: number;
  status: ItemStatus;
  attempt: number;
  durationMs: number | null;
  errorMessage: string | null;
  failedStepId: string | null;
};
export type RunDetail = Run & {
  items: RunItem[];
  environment: { id: string; name: string; baseUrl: string; isProduction: boolean } | null;
  application: { id: string; name: string; color: string };
};

export type AssertionResult = {
  target: string;
  operator: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  message: string;
};
export type StepResultRow = {
  id: string;
  stepId: string | null;
  position: number;
  type: string;
  label: string;
  status: 'passed' | 'failed' | 'broken' | 'skipped';
  durationMs: number | null;
  message: string | null;
  screenshotPath: string | null;
  requestJson?: unknown;
  responseJson: {
    assertions?: AssertionResult[];
    attempts?: number;
    path?: string;
    depth?: number;
    errorKind?: string;
    healedLocator?: {
      from: { strategy: string; value: string; name?: string };
      to: { strategy: string; value: string; name?: string };
    };
  } | null;
};
export type Artifact = { id: string; kind: string; path: string; size: number };
export type RunItemDetail = RunItem & { steps: StepResultRow[]; artifacts: Artifact[] };
