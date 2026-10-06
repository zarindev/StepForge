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
