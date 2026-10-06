/** Typed form fields per step type. Types without a spec fall back to the JSON parameters editor. */
export type FieldSpec = {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'checkbox' | 'json' | 'code' | 'scenario' | 'block';
  options?: string[];
  language?: 'json' | 'sql' | 'javascript';
  placeholder?: string;
  hint?: string;
  wide?: boolean;
};

const ASSERT_CHECKS = [
  'visible',
  'hidden',
  'text',
  'textContains',
  'textMatches',
  'value',
  'count',
  'attribute',
  'enabled',
  'disabled',
  'checked',
  'unchecked',
  'url',
  'urlContains',
  'urlMatches',
  'title',
  'titleContains',
];
const OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
];
const DATA_KINDS = [
  'name',
  'firstName',
  'lastName',
  'email',
  'phone',
  'date',
  'birthdate',
  'number',
  'uuid',
  'word',
  'sentence',
  'address',
  'company',
  'pattern',
];

export const STEP_FIELDS: Record<string, FieldSpec[]> = {
  'ui.navigate': [
    { key: 'url', label: 'URL', kind: 'text', placeholder: '/login or {{env.baseUrl}}/login', wide: true },
    {
      key: 'waitUntil',
      label: 'Wait until',
      kind: 'select',
      options: ['load', 'domcontentloaded', 'networkidle'],
    },
  ],
  'ui.fill': [{ key: 'value', label: 'Value', kind: 'text', placeholder: '{{data.email}}', wide: true }],
  'ui.type': [
    { key: 'value', label: 'Value', kind: 'text', wide: true },
    { key: 'delay', label: 'Delay per key (ms)', kind: 'number' },
  ],
  'ui.press': [{ key: 'key', label: 'Key', kind: 'text', placeholder: 'Enter, Escape, Control+A' }],
  'ui.select': [
    { key: 'label', label: 'Option label', kind: 'text' },
    { key: 'value', label: 'or option value', kind: 'text' },
  ],
  'ui.click': [{ key: 'force', label: 'Force (skip actionability checks)', kind: 'checkbox' }],
  'ui.upload': [{ key: 'files', label: 'Files (comma separated paths)', kind: 'text', wide: true }],
  'ui.switchTab': [
    { key: 'urlContains', label: 'URL contains', kind: 'text' },
    { key: 'index', label: 'or tab index', kind: 'number' },
  ],
  'ui.handleDialog': [
    { key: 'action', label: 'Action', kind: 'select', options: ['accept', 'dismiss'] },
    { key: 'promptText', label: 'Prompt text', kind: 'text' },
  ],
  'ui.switchFrame': [
    { key: 'selector', label: 'Frame selector', kind: 'text', placeholder: '#payment-iframe' },
    { key: 'main', label: 'Back to main page', kind: 'checkbox' },
  ],
  'ui.waitFor': [
    {
      key: 'state',
      label: 'Element state',
      kind: 'select',
      options: ['visible', 'hidden', 'attached', 'detached'],
    },
    { key: 'url', label: 'or URL (glob)', kind: 'text', placeholder: '**/dashboard' },
  ],
  'ui.screenshot': [{ key: 'fullPage', label: 'Full page', kind: 'checkbox' }],
  'ui.extract': [
    {
      key: 'from',
      label: 'Read',
      kind: 'select',
      options: ['text', 'value', 'attribute', 'count', 'url', 'title'],
    },
    { key: 'attribute', label: 'Attribute', kind: 'text' },
    { key: 'regex', label: 'Regex (group 1)', kind: 'text', placeholder: 'PAT-(\\d+)' },
  ],
  'ui.assert': [
    { key: 'check', label: 'Check', kind: 'select', options: ASSERT_CHECKS },
    { key: 'expected', label: 'Expected', kind: 'text', wide: true },
    { key: 'attribute', label: 'Attribute (for attribute check)', kind: 'text' },
  ],
  'api.request': [
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    },
    { key: 'url', label: 'URL', kind: 'text', placeholder: '{{env.baseUrl}}/api/patients', wide: true },
    { key: 'headers', label: 'Headers (JSON)', kind: 'code', language: 'json', wide: true },
    { key: 'query', label: 'Query (JSON)', kind: 'code', language: 'json', wide: true },
    {
      key: 'bodyType',
      label: 'Body type',
      kind: 'select',
      options: ['json', 'form', 'multipart', 'raw', 'none'],
    },
    { key: 'body', label: 'Body (JSON)', kind: 'code', language: 'json', wide: true },
    {
      key: 'auth',
      label: 'Auth (JSON: bearer/basic/apiKey/oauth2/cookie)',
      kind: 'code',
      language: 'json',
      wide: true,
      hint: '{"type":"bearer","token":"{{secret.apiToken}}"}',
    },
    { key: 'contract', label: 'Check OpenAPI contract', kind: 'checkbox' },
  ],
  'api.graphql': [
    { key: 'url', label: 'Endpoint', kind: 'text', placeholder: '{{env.baseUrl}}/graphql', wide: true },
    { key: 'query', label: 'Query', kind: 'code', language: 'javascript', wide: true },
    { key: 'variables', label: 'Variables (JSON)', kind: 'code', language: 'json', wide: true },
    { key: 'allowErrors', label: 'Allow GraphQL errors', kind: 'checkbox' },
  ],
  'api.extract': [
    { key: 'from', label: 'From last response', kind: 'select', options: ['body', 'header', 'status'] },
    { key: 'path', label: 'JSONPath', kind: 'text', placeholder: '$.data.token' },
    { key: 'name', label: 'Header name', kind: 'text' },
  ],
  'db.query': [
    { key: 'connection', label: 'Connection', kind: 'text', hint: 'Database connections arrive in Phase 6' },
    { key: 'sql', label: 'SQL', kind: 'code', language: 'sql', wide: true },
  ],
  'email.waitForEmail': [
    { key: 'to', label: 'To', kind: 'text' },
    { key: 'subject', label: 'Subject contains', kind: 'text' },
    { key: 'timeoutMs', label: 'Timeout (ms)', kind: 'number' },
  ],
  'util.setVariable': [
    { key: 'name', label: 'Variable name', kind: 'text' },
    { key: 'value', label: 'Value', kind: 'text', wide: true },
  ],
  'util.generateData': [
    { key: 'kind', label: 'Kind', kind: 'select', options: DATA_KINDS },
    { key: 'pattern', label: 'Pattern (# digit, ? letter)', kind: 'text', placeholder: 'PAT-####' },
    { key: 'name', label: 'Store as variable', kind: 'text' },
  ],
  'util.wait': [
    { key: 'ms', label: 'Milliseconds', kind: 'number', hint: 'Prefer ui.waitFor on a condition' },
  ],
  'util.log': [{ key: 'message', label: 'Message', kind: 'text', wide: true }],
  'util.runScript': [
    {
      key: 'code',
      label: 'JavaScript (return a value; read/write vars.x)',
      kind: 'code',
      language: 'javascript',
      wide: true,
    },
  ],
  'util.if': [
    { key: 'condition.value', label: 'If value', kind: 'text', placeholder: '{{vars.count}}' },
    { key: 'condition.operator', label: 'Operator', kind: 'select', options: OPERATORS },
    { key: 'condition.expected', label: 'Expected', kind: 'text' },
  ],
  'util.loop': [
    { key: 'count', label: 'Repeat N times', kind: 'number' },
    { key: 'over', label: 'or for each item in', kind: 'text', placeholder: '{{vars.items}}' },
    { key: 'as', label: 'Item variable', kind: 'text', placeholder: 'item' },
  ],
  'util.callScenario': [{ key: 'scenarioId', label: 'Scenario', kind: 'scenario', wide: true }],
  'util.useBlock': [{ key: 'blockId', label: 'Block', kind: 'block', wide: true }],
};

/** Steps that take an element locator. */
export const NEEDS_LOCATOR = new Set([
  'ui.click',
  'ui.dblclick',
  'ui.rightclick',
  'ui.hover',
  'ui.fill',
  'ui.type',
  'ui.clear',
  'ui.press',
  'ui.select',
  'ui.check',
  'ui.uncheck',
  'ui.upload',
  'ui.dragDrop',
  'ui.scroll',
  'ui.waitFor',
  'ui.screenshot',
  'ui.extract',
  'ui.assert',
]);

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const copy = { ...obj };
  if (rest.length === 0) {
    if (value === undefined || value === '') delete copy[head];
    else copy[head] = value;
    return copy;
  }
  copy[head] = setPath((obj[head] as Record<string, unknown>) ?? {}, rest.join('.'), value);
  return copy;
}
