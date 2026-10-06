export type Owner = 'test' | 'app' | 'environment' | 'data';

export type AssertionLike = {
  target: string;
  operator: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  message: string;
};

export type LocatorLike = { strategy: string; value: string; name?: string };

/** A step result as the runner stores it. */
export type StepSnapshot = {
  stepId?: string;
  type: string;
  label?: string;
  path?: string;
  status: string;
  message?: string;
  errorKind?: string;
  durationMs?: number;
  assertions?: AssertionLike[];
  request?: { method?: string; url?: string } & Record<string, unknown>;
  response?: { status?: number; body?: unknown; timeMs?: number; headers?: Record<string, string> } & Record<
    string,
    unknown
  >;
  query?: Record<string, unknown>;
  email?: Record<string, unknown>;
  perf?: Record<string, unknown>;
  healedLocator?: { from: LocatorLike; to: LocatorLike };
  /** Evidence gathered by the executor at failure time (e.g. locator candidates, element state). */
  diagnostics?: {
    matchCount?: number;
    visible?: boolean;
    candidates?: { locator: LocatorLike; text?: string; score: number; count: number }[];
  };
  /** From the scenario definition. */
  locators?: LocatorLike[];
  params?: Record<string, unknown>;
  timeoutMs?: number;
};

export type ConsoleEntry = { type: string; text: string; location?: string; at?: number };
export type NetworkEntry = {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  failure?: string;
};

export type DiagnosisInput = {
  failed: StepSnapshot;
  /** Item status: failed/broken, or flaky (failed, then passed on retry). */
  itemStatus: string;
  attempts?: number;
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  /** Statuses of this test's recent runs, newest first (excluding the current one). */
  history?: string[];
  /** The same test's last passing run, if any. */
  lastGreen?: {
    runId: string;
    at: string;
    /** The same step in that run. */
    step?: StepSnapshot;
    durationMs?: number;
    browser?: string;
    baseUrl?: string;
  };
  current?: { browser?: string; baseUrl?: string; viewport?: string; durationMs?: number };
};

export type LastGreenDiff = {
  runId: string;
  at: string;
  changes: { what: string; before: string; after: string }[];
};

export type Diagnosis = {
  ruleId: string;
  category: string;
  title: string;
  explanation: string;
  owner: Owner;
  fix: string;
  /** 0–1. */
  confidence: number;
  /** Where it failed. */
  where: { step: string; path?: string; type: string };
  evidence: { label: string; value: string }[];
  /** A locator that would find the element now (locator changed). */
  suggestedLocator?: LocatorLike;
  lastGreen?: LastGreenDiff;
  /** Other rules that also matched, best first. */
  alternatives: { ruleId: string; category: string; title: string; confidence: number }[];
};
