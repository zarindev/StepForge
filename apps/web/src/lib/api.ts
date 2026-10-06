declare global {
  interface Window {
    __STEPFORGE__?: { token: string };
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function sessionToken(): string {
  return window.__STEPFORGE__?.token ?? '';
}

/** URL of an evidence file; the token travels as a query param because <img>/<video> cannot set headers. */
export function artifactUrl(path: string): string {
  return `/api/artifacts/files/${path.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(sessionToken())}`;
}

/** Opens Playwright's Trace Viewer (served locally) on a trace artifact. */
export function traceViewerUrl(path: string): string {
  return `/trace-viewer/index.html?trace=${encodeURIComponent(location.origin + artifactUrl(path))}`;
}

/** Typed fetch wrapper for the local StepForge API. Adds the session token to every request. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: {
      'x-stepforge-token': sessionToken(),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const b = (typeof body === 'object' ? body : {}) as {
      error?: string;
      message?: string;
      issues?: unknown;
    };
    throw new ApiError(
      res.status,
      b.error ?? 'http_error',
      b.message ?? `Request failed (${res.status})`,
      b.issues,
    );
  }
  return body as T;
}

export type SystemInfo = {
  version: string;
  node: string;
  platform: string;
  dataDir: string;
  startedAt: string;
  counts: Record<'applications' | 'scenarios' | 'testCases' | 'runs' | 'openBugs', number>;
  stepCatalogue: Record<string, string[]>;
};

export type Settings = {
  theme: 'dark' | 'light' | 'system';
  onboardingComplete: boolean;
  defaultBrowser: 'chromium' | 'firefox' | 'webkit';
  defaultViewport: 'desktop' | 'tablet' | 'mobile';
  defaultTimeoutMs: number;
  workers: number;
  retention: { keepFailures: boolean; prunePassesAfterDays: number };
  ollama: { url: string; model: string };
  k6Path: string;
  reportBranding: { author: string; company: string; accent: string };
};

/**
 * Downloads a generated file (report, export). A plain link with the session token in the query string lets the
 * browser handle large files natively.
 */
export function download(path: string): void {
  const a = document.createElement('a');
  a.href = `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(sessionToken())}`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
