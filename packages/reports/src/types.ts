/** Who prepared a report. The author defaults to StepForge's creator and can be changed in Settings. */
export type Branding = { author: string; company?: string; accent?: string };

export const STEPFORGE_AUTHOR = 'Md Zarin Tasnim';
/** Printed on every generated document. */
export const CREDIT = `StepForge by ${STEPFORGE_AUTHOR}`;
export const DEFAULT_BRANDING: Branding = { author: STEPFORGE_AUTHOR, accent: '#F97316' };

export type DiagnosisSummary = {
  category: string;
  title: string;
  explanation: string;
  owner: string;
  fix: string;
  confidence: number;
  where?: { step: string; path?: string };
  evidence?: { label: string; value: string }[];
};

export type BugReportData = {
  code: string;
  title: string;
  summary: string;
  severity: string;
  priority: string;
  status: string;
  application: string;
  module?: string;
  scenario?: string;
  testCase?: string;
  environment: { name?: string; url?: string; browser?: string; viewport?: string; os?: string; at?: string };
  preconditions: string;
  steps: string[];
  expected: string;
  actual: string;
  diagnosis?: DiagnosisSummary;
  owner?: string;
  occurrences: number;
  createdAt: string;
  lastSeenAt?: string;
  evidence: {
    /** data: URI of the (annotated) failure screenshot. */
    screenshot?: string;
    request?: string;
    response?: string;
    /** Other evidence available in StepForge (video, trace, logs). */
    files: string[];
  };
};

export type RunReportItem = {
  title: string;
  module?: string;
  status: string;
  durationMs?: number;
  error?: string;
  diagnosis?: DiagnosisSummary;
  steps: { path: string; label: string; status: string; durationMs?: number; message?: string }[];
  screenshot?: string;
};

export type RunReportData = {
  application: string;
  environment: { name?: string; url?: string };
  run: {
    id: string;
    status: string;
    trigger?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    browser?: string;
    viewport?: string;
    totals: { total: number; passed: number; failed: number; broken: number; skipped: number; flaky: number };
  };
  items: RunReportItem[];
};
