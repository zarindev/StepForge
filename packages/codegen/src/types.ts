/** What a generator needs, gathered by the server. Never contains secret values: only their names. */
export type CodegenStep = {
  id?: string;
  type: string;
  label?: string;
  params: Record<string, unknown>;
  locators: { strategy: string; value: string; name?: string }[];
  assertions: { target: string; operator: string; expected?: unknown; message?: string }[];
  enabled?: boolean;
  continueOnFail?: boolean;
  timeoutMs?: number;
  captureAs?: string;
};

export type CodegenTestCase = {
  code: string;
  title: string;
  data: Record<string, unknown>;
  expectedResult?: string;
  priority?: string;
};

export type CodegenScenario = {
  id: string;
  name: string;
  description?: string;
  /** Module names from the root, e.g. ["Patients", "Registration"]. */
  modulePath: string[];
  priority: string;
  tags: string[];
  preconditions?: string;
  steps: CodegenStep[];
  testCases: CodegenTestCase[];
};

export type CodegenInput = {
  application: { name: string; slug: string };
  environment: {
    name: string;
    baseUrl: string;
    /** Plain (non-secret) environment variables, exported as defaults. */
    variables: Record<string, string>;
    /** Names only. */
    secretKeys: string[];
  };
  connections: { name: string; engine: 'pg' | 'mysql' | 'mssql' | 'sqlite' | 'mongo' }[];
  inboxes: { name: string; kind: 'mailpit' | 'imap' }[];
  scenarios: CodegenScenario[];
  /** Targets of `util.useBlock` / `util.callScenario`, inlined into the generated tests. */
  blocks: Record<string, { name: string; steps: CodegenStep[] }>;
  library: Record<string, { name: string; steps: CodegenStep[] }>;
  author: string;
  /** ISO time printed in generated headers (fixed in snapshot tests). */
  generatedAt: string;
};

export type CiProvider = 'github' | 'gitlab';

export type CodegenOptions = {
  target: TargetId;
  /** Page Object Model instead of inline locators (UI targets). */
  pom?: boolean;
  ci?: CiProvider[];
};

export type Warning = { scenario?: string; step?: string; message: string };

export type GeneratedProject = {
  target: TargetId;
  /** Relative path → content. */
  files: Record<string, string | Buffer>;
  warnings: Warning[];
  /** How to run it, shown in the export dialog. */
  run: string;
};

export const TARGET_IDS = [
  'playwright-ts',
  'playwright-py',
  'cypress-js',
  'selenium-py',
  'selenium-java',
  'pytest-requests',
  'rest-assured',
  'k6',
  'postman',
  'curl',
  'docs-markdown',
  'docs-gherkin',
  'docs-xlsx',
] as const;
export type TargetId = (typeof TARGET_IDS)[number];
