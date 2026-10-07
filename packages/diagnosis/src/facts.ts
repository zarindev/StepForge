import type { AssertionLike, DiagnosisInput, LocatorLike, NetworkEntry } from './types.ts';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export const describeLocator = (l: LocatorLike) =>
  l.strategy === 'role' ? `role=${l.value}${l.name ? ` "${l.name}"` : ''}` : `${l.strategy}=${l.value}`;

const fmt = (v: unknown): string =>
  v === undefined ? 'nothing' : v === null ? 'null' : typeof v === 'string' ? `"${v}"` : JSON.stringify(v);

const isXhr = (n: NetworkEntry) => n.resourceType === 'xhr' || n.resourceType === 'fetch';

function firstFailedAssertion(a: AssertionLike[] = []) {
  return a.find((x) => !x.passed);
}

/**
 * Flattens a failure into facts that rules match on and templates print. Every value is real (from the run),
 * so explanations can say "fee should be number" or "COUNT returned 1, expected 0".
 */
export function buildFacts(input: DiagnosisInput): Record<string, unknown> {
  const f = input.failed;
  const layer = f.type.split('.')[0]!;
  const message = f.message ?? '';
  const failedAssertion = firstFailedAssertion(f.assertions);
  const statusAssertion = (f.assertions ?? []).find((a) => a.target === 'status' && !a.passed);
  const status = typeof f.response?.status === 'number' ? f.response.status : undefined;
  const expectedStatus = statusAssertion ? Number(statusAssertion.expected) : undefined;

  // Schema problems: JSON Schema assertion errors and OpenAPI contract violations, field by field.
  const schemaErrors = (f.assertions ?? [])
    .filter((a) => !a.passed && (a.operator === 'matchesSchema' || a.target === 'contract'))
    .flatMap((a) =>
      Array.isArray(a.actual)
        ? (a.actual as string[])
        : a.message.replace(/^(Schema mismatch|Contract violation[^:]*): /, '').split('; '),
    )
    .filter(Boolean);

  const consoleErrors = (input.console ?? []).filter((c) => c.type === 'error' || c.type === 'pageerror');
  // A JavaScript error explains a UI failure only when it was thrown on the page the step failed on
  // (an error on an earlier page, e.g. the dashboard after login, does not break a later page).
  const pagePath = (u: string | undefined) => {
    const m = /(https?:\/\/[^\s)]+?)(?::\d+)*\)?$/.exec(u ?? '');
    try {
      return m ? new URL(m[1]!).pathname : undefined;
    } catch {
      return undefined;
    }
  };
  const failedOn = f.diagnostics?.pageUrl ? pagePath(f.diagnostics.pageUrl) : undefined;
  const pageError = (input.console ?? []).find(
    (c) =>
      c.type === 'pageerror' &&
      (failedOn === undefined || pagePath(c.location) === undefined || pagePath(c.location) === failedOn),
  );
  const corsError = consoleErrors.find((c) => /CORS|Access-Control-Allow-Origin|cross-origin/i.test(c.text));
  const net = input.network ?? [];
  const failedRequests = net.filter((n) => isXhr(n) && ((n.status ?? 0) >= 400 || !!n.failure));
  const netFailure =
    net.find((n) =>
      /ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|NETWORK_CHANGED)/.test(
        n.failure ?? '',
      ),
    )?.failure ??
    /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED)/.exec(
      message,
    )?.[1];
  const slowest = net.filter(isXhr).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
  const timeoutMs = f.timeoutMs;

  const delta =
    failedAssertion &&
    Number.isFinite(Number(failedAssertion.actual)) &&
    Number.isFinite(Number(failedAssertion.expected)) &&
    failedAssertion.actual !== null &&
    failedAssertion.actual !== '' &&
    typeof failedAssertion.actual !== 'boolean'
      ? Number(failedAssertion.actual) - Number(failedAssertion.expected)
      : undefined;

  const perfFailure = layer === 'perf' ? failedAssertion : undefined;
  const lgStep = input.lastGreen?.step;
  const lgPerf = (lgStep?.perf as { latency?: { p95?: number } } | undefined)?.latency?.p95;
  const lgDuration = input.lastGreen?.durationMs;

  const history = input.history ?? [];
  const mixedHistory = history.slice(0, 10);
  const passedRecently = mixedHistory.filter((s) => s === 'passed' || s === 'flaky').length;
  const failedRecently = mixedHistory.filter((s) => s === 'failed' || s === 'broken').length;

  const candidates = f.diagnostics?.candidates ?? [];
  const best = candidates[0];
  const query = f.query as { rowCount?: number; sql?: string; connection?: string } | undefined;

  return {
    layer,
    stepType: f.type,
    stepLabel: f.label || f.type,
    stepPath: f.path ?? '',
    errorKind: f.errorKind ?? 'unknown',
    message,
    itemStatus: input.itemStatus,
    attempts: input.attempts ?? 1,

    // Assertions
    assertion: failedAssertion
      ? {
          target: failedAssertion.target,
          operator: failedAssertion.operator,
          expected: fmt(failedAssertion.expected),
          actual: fmt(failedAssertion.actual),
          message: failedAssertion.message,
        }
      : undefined,
    delta,
    deltaText: delta === undefined ? '' : `${delta > 0 ? '+' : ''}${Math.round(delta * 1000) / 1000}`,

    // HTTP (API steps)
    request: f.request ? { method: f.request.method ?? '', url: f.request.url ?? '' } : undefined,
    status,
    statusText: status ? (STATUS_TEXT[status] ?? '') : '',
    expectedStatus,
    expectedStatusText: expectedStatus ? (STATUS_TEXT[expectedStatus] ?? '') : '',
    responseTimeMs: f.response?.timeMs,
    // Server message, ready to append to a sentence: `: "Patient not found"` (empty when there is none).
    responseMessage: (() => {
      const b = f.response?.body;
      const m =
        b && typeof b === 'object'
          ? ((b as Record<string, unknown>).message ?? (b as Record<string, unknown>).error)
          : undefined;
      return m ? `: "${String(m)}"` : '';
    })(),
    schemaErrors,
    schemaErrorCount: schemaErrors.length,
    schemaErrorList: schemaErrors.slice(0, 5).join('; '),

    // Browser (UI steps)
    healed: !!f.healedLocator,
    locator: f.locators?.[0] ? describeLocator(f.locators[0]) : '',
    matchCount: f.diagnostics?.matchCount,
    visible: f.diagnostics?.visible,
    candidateCount: candidates.length,
    candidate: best ? describeLocator(best.locator) : '',
    candidateText: best?.text ? ` showing "${best.text}"` : '',
    consoleErrorCount: consoleErrors.length,
    pageError: pageError
      ? { text: pageError.text, location: pageError.location ?? 'unknown location' }
      : undefined,
    corsError: corsError?.text,
    failedRequestCount: failedRequests.length,
    failedRequest: failedRequests[0]
      ? {
          method: failedRequests[0].method,
          url: failedRequests[0].url,
          status: failedRequests[0].status ?? 0,
          failure: failedRequests[0].failure ?? '',
        }
      : undefined,
    networkFailure: netFailure,
    slowRequest: slowest?.durationMs
      ? { method: slowest.method, url: slowest.url, durationMs: slowest.durationMs }
      : undefined,
    slowRatio:
      slowest?.durationMs && timeoutMs ? Math.round((slowest.durationMs / timeoutMs) * 100) / 100 : undefined,
    timeoutMs,

    // Database
    rowCount: query?.rowCount,
    connection: query?.connection ?? (f.params?.connection as string | undefined),
    sql: query?.sql ? String(query.sql).replace(/\s+/g, ' ').slice(0, 160) : '',

    // Performance
    perfMetric: perfFailure?.target,
    perfActual: perfFailure?.actual,
    perfThreshold: perfFailure?.expected,
    perfBaselineP95: lgPerf,

    // History
    lastGreen: input.lastGreen ? { at: input.lastGreen.at, runId: input.lastGreen.runId } : undefined,
    lastGreenDurationMs: lgDuration,
    durationRatio:
      lgDuration && input.current?.durationMs
        ? Math.round((input.current.durationMs / lgDuration) * 10) / 10
        : undefined,
    historyCount: mixedHistory.length,
    passedRecently,
    failedRecently,
    flakyHistory: passedRecently > 0 && failedRecently > 0,
  };
}
