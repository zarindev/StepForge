export type { Locator, StepInput } from '@stepforge/core';

/** Starter params for steps inserted from the recorder toolbar. */
export function defaultParamsFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'api.request':
      return { method: 'GET', url: '{{env.baseUrl}}/api/', headers: {} };
    case 'db.query':
      return { connection: '', sql: 'SELECT 1' };
    case 'email.waitForEmail':
      return { to: '', subject: '', timeoutMs: 30000 };
    case 'util.wait':
      return { ms: 1000 };
    case 'util.log':
      return { message: 'Note' };
    default:
      return {};
  }
}
