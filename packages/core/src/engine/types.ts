import type { Assertion, Locator, Step, StepGroup } from '../schemas/steps.ts';
import type { VariableResolver } from '../variables.ts';

export type StepStatus = 'passed' | 'failed' | 'broken' | 'skipped';
export type TestCaseStatus = 'passed' | 'failed' | 'broken' | 'skipped';
export type EvidenceMode = 'off' | 'onFailure' | 'always';

/** A step with an id and position, after variable resolution. */
export type RunnableStep = Step & { id: string; position: number };

export type AssertionResult = {
  target: string;
  operator: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  message: string;
};

export type ArtifactRef = {
  kind:
    | 'video'
    | 'trace'
    | 'screenshot'
    | 'har'
    | 'console'
    | 'network'
    | 'email'
    | 'lighthouse'
    | 'load_report'
    | 'dom';
  /** Absolute path on disk. */
  path: string;
  stepId?: string;
};

/** A visual checkpoint: the screenshot compared with the approved baseline (absolute paths). */
export type VisualResult = {
  /** Baseline file name, per step, browser and screen size. */
  key: string;
  baseline: string;
  actual: string;
  diff?: string;
  /** Share of differing pixels, in percent. */
  diffPercent?: number;
  maxDiffPercent: number;
  status: 'new' | 'match' | 'changed' | 'sizeChanged';
  size?: { width: number; height: number; baselineWidth?: number; baselineHeight?: number };
};

/**
 * Browser settings of an environment (applied to every test's browser context): language, time zone, location,
 * permissions, dark mode, sign-in for HTTP basic auth, extra headers, a proxy, client certificates, a branded browser.
 */
export type BrowserSettings = {
  channel?: 'chrome' | 'msedge';
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: string[];
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string };
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  clientCertificates?: {
    origin: string;
    certPath?: string;
    keyPath?: string;
    pfxPath?: string;
    passphrase?: string;
  }[];
  serviceWorkers?: 'allow' | 'block';
  javaScriptEnabled?: boolean;
};

/** How to start an Electron desktop app (see ElectronLaunchInput). */
export type ElectronLaunch = {
  executablePath?: string;
  appPath?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

/** What an executor reports back for one step. */
export type StepOutcome = {
  message?: string;
  /** Primary output, stored in vars when the step has `captureAs`. */
  output?: unknown;
  /** Values for step.assertions targets (e.g. `url`, `text`, `status`). */
  getTarget?: (target: string) => unknown | Promise<unknown>;
  /**
   * Lets an executor judge assertions the generic evaluator cannot (e.g. `matchesSchema`, OpenAPI contract).
   * Return undefined to fall back to the generic evaluator.
   */
  evaluate?: (assertion: Assertion) => AssertionResult | undefined | Promise<AssertionResult | undefined>;
  /** Checks the executor ran itself (e.g. an OpenAPI contract), reported alongside the step's assertions. */
  assertions?: AssertionResult[];
  request?: unknown;
  response?: unknown;
  query?: unknown;
  /** The email a step received or worked on (shown as a preview in results). */
  email?: unknown;
  /** A performance report (load test, Lighthouse, page metrics, query plan) shown in results. */
  perf?: unknown;
  /** A visual checkpoint's images and difference (see VisualResult). */
  visual?: VisualResult;
  /** Facts collected at failure time for the diagnosis (e.g. element state, locator candidates). */
  diagnostics?: unknown;
  screenshotPath?: string;
  /** Set when the first-ranked locator failed and a lower-ranked one matched (self-healing). */
  healedLocator?: { from: Locator; to: Locator };
  artifacts?: ArtifactRef[];
  metrics?: { metric: string; value: number; unit: string; threshold?: number; passed?: boolean }[];
};

export type StepResult = {
  stepId: string;
  /** Global execution order (unique per test case, also used for evidence file names). */
  position: number;
  /** Human path in the step tree, e.g. "3" or "4.2" or "5[2].1" for loop iteration 2. */
  path: string;
  depth: number;
  type: string;
  label: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  message?: string;
  errorKind?: string;
  assertions: AssertionResult[];
  request?: unknown;
  response?: unknown;
  query?: unknown;
  email?: unknown;
  perf?: unknown;
  visual?: VisualResult;
  diagnostics?: unknown;
  screenshotPath?: string;
  healedLocator?: StepOutcome['healedLocator'];
  metrics?: StepOutcome['metrics'];
};

export type TestCaseResult = {
  status: TestCaseStatus;
  durationMs: number;
  steps: StepResult[];
  error?: string;
  errorKind?: string;
  failedStepId?: string;
  artifacts: ArtifactRef[];
  vars: Record<string, unknown>;
};

export type EngineEvent =
  | {
      type: 'step.started';
      stepId: string;
      position: number;
      path: string;
      depth: number;
      stepType: string;
      label: string;
    }
  | { type: 'step.finished'; result: StepResult }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Per test case context shared by all executor sessions. */
export type TestContext = {
  runId: string;
  artifactsDir: string;
  resolver: VariableResolver;
  options: RunOptions;
  signal: AbortSignal;
  /** Cross-executor shared state, e.g. the UI executor publishes its `page`. */
  shared: Map<string, unknown>;
  /** When the test case started (epoch ms), e.g. to ignore emails that arrived before it. */
  startedAt: number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export type StepContext = TestContext & { timeoutMs: number; stepIndex: number };

/** A condition on the page (util.if / util.loop "while"): does an element meet a check, within a short wait? */
export type ProbeCheck = 'visible' | 'hidden' | 'present' | 'absent' | 'enabled' | 'textContains' | 'count';
export type ProbeRequest = {
  locators: RunnableStep['locators'];
  check: ProbeCheck;
  expected?: unknown;
  timeoutMs: number;
};

export interface ExecutorSession {
  execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome>;
  /** Answers a page condition without failing: true once the check holds, false when the wait runs out. */
  probe?(req: ProbeRequest, ctx: StepContext): Promise<{ ok: boolean; detail: string }>;
  /** Called when a step fails, to collect failure evidence (screenshot, DOM…). */
  onStepFailed?(step: RunnableStep, ctx: StepContext): Promise<Partial<StepOutcome>>;
  /** Release resources; returns artifacts worth keeping given the final status. */
  close(result: { failed: boolean }): Promise<ArtifactRef[]>;
}

export interface Executor {
  group: StepGroup;
  createSession(ctx: TestContext): Promise<ExecutorSession>;
}

export type RunOptions = {
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport: { width: number; height: number };
  headed: boolean;
  defaultTimeoutMs: number;
  video: EvidenceMode;
  trace: EvidenceMode;
  screenshots: 'off' | 'onFailure' | 'everyStep';
  /** Per-step network/console capture for diagnosis. */
  captureLogs: boolean;
  /** Record page metrics (Web Vitals) after every ui.navigate. */
  pageMetrics?: boolean;
  /** Phone or tablet: touch, a mobile browser identity (Chromium/WebKit), so sites serve their mobile version. */
  device?: 'desktop' | 'tablet' | 'mobile';
  /** The environment's browser settings. */
  browserSettings?: BrowserSettings;
  /** Set for an Electron desktop app: the UI steps run in the app's windows instead of a browser. */
  electron?: ElectronLaunch;
  baseUrl?: string;
};

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  browser: 'chromium',
  viewport: { width: 1440, height: 900 },
  headed: false,
  defaultTimeoutMs: 15_000,
  video: 'onFailure',
  trace: 'onFailure',
  screenshots: 'everyStep',
  captureLogs: true,
};

/** Errors an executor throws to classify a failure. */
export type StepErrorKind =
  | 'assertion'
  | 'timeout'
  | 'element_not_found'
  | 'navigation'
  | 'network'
  | 'unsupported'
  | 'invalid_params'
  | 'variable'
  | 'script'
  | 'aborted'
  | 'unknown';

export class StepError extends Error {
  constructor(
    public readonly kind: StepErrorKind,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

/** Configuration problems make a test `broken`; product/assertion problems make it `failed`. */
export const BROKEN_KINDS: ReadonlySet<StepErrorKind> = new Set([
  'unsupported',
  'invalid_params',
  'variable',
  'script',
]);

export type { Assertion, Locator };
