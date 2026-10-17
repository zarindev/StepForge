/** Typed form fields per step type. Types without a spec fall back to the JSON parameters editor. */
export type FieldSpec = {
  key: string;
  label: string;
  kind:
    | 'text'
    | 'number'
    | 'select'
    | 'checkbox'
    | 'json'
    | 'code'
    | 'scenario'
    | 'block'
    | 'connection'
    | 'inbox'
    | 'dataSource';
  options?: string[];
  language?: 'json' | 'sql' | 'javascript';
  placeholder?: string;
  hint?: string;
  wide?: boolean;
  /** Only shown when another field has one of these values (e.g. the row number for pick = row). */
  showWhen?: { key: string; equals: string[] };
  /** Emptying this field removes the whole object it is in (e.g. clearing "Repeat while — compare" drops `while`). */
  clearsParent?: boolean;
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

/** Checks a page condition can make on the step's element (the engine's probe). */
export const PAGE_CHECKS = ['visible', 'hidden', 'present', 'absent', 'enabled', 'textContains', 'count'];

/**
 * Fields of a condition (`util.if` condition, `util.loop` while): a value comparison, or a check on the page — the
 * element is the step's own element.
 */
function conditionFields(at: string, label: string): FieldSpec[] {
  // A condition without a type compares values; a loop without one has no "while".
  const value = { key: `${at}.type`, equals: at === 'while' ? ['value'] : ['', 'value'] };
  const element = { key: `${at}.type`, equals: ['element'] };
  return [
    {
      key: `${at}.type`,
      label: `${label} — compare`,
      kind: 'select',
      options: ['value', 'element'],
      hint: at === 'while' ? 'Empty: no “while” (count / for each)' : 'element: check something on the page',
      // Otherwise the other while keys stay behind and the loop is still, invisibly, a while loop.
      ...(at === 'while' && { clearsParent: true }),
    },
    { key: `${at}.value`, label: 'Value', kind: 'text', placeholder: '{{vars.count}}', showWhen: value },
    { key: `${at}.operator`, label: 'Operator', kind: 'select', options: OPERATORS, showWhen: value },
    { key: `${at}.check`, label: 'Element is', kind: 'select', options: PAGE_CHECKS, showWhen: element },
    {
      key: `${at}.expected`,
      label: 'Expected',
      kind: 'text',
      hint: 'For textContains (text) and count (number)',
      showWhen: element,
    },
    { key: `${at}.expected`, label: 'Expected', kind: 'text', showWhen: value },
    {
      key: `${at}.timeoutMs`,
      label: 'Wait up to (ms)',
      kind: 'number',
      hint: 'Default 2000',
      showWhen: element,
    },
  ];
}

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
  'ui.click': [
    { key: 'force', label: 'Force (skip actionability checks)', kind: 'checkbox' },
    {
      key: 'x',
      label: 'At x (px, optional)',
      kind: 'number',
      hint: 'A point inside the element, e.g. on a canvas or map',
    },
    { key: 'y', label: 'At y (px)', kind: 'number' },
  ],
  'ui.tap': [
    {
      key: 'x',
      label: 'At x (px, optional)',
      kind: 'number',
      hint: 'A point inside the element, e.g. on a canvas or map',
    },
    { key: 'y', label: 'At y (px)', kind: 'number' },
  ],
  // Clicks the element and keeps the file; check it with assertions on fileName, size or content.
  'ui.download': [],
  'ui.waitForResponse': [
    {
      key: 'url',
      label: 'URL contains (or glob)',
      kind: 'text',
      placeholder: '/api/orders or **/api/orders*',
      wide: true,
    },
    { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'status', label: 'Status', kind: 'number', hint: 'Optional: only a response with this status' },
  ],
  'ui.mockRoute': [
    { key: 'url', label: 'URL contains (or glob)', kind: 'text', placeholder: '/api/orders', wide: true },
    {
      key: 'action',
      label: 'Do',
      kind: 'select',
      options: ['fulfill', 'abort', 'delay', 'remove'],
      hint: 'fulfill: answer with this; abort: network error; remove: stop mocking',
    },
    { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'status', label: 'Status', kind: 'number', showWhen: { key: 'action', equals: ['', 'fulfill'] } },
    {
      key: 'body',
      label: 'Body',
      kind: 'code',
      language: 'json',
      wide: true,
      showWhen: { key: 'action', equals: ['', 'fulfill'] },
    },
    {
      key: 'contentType',
      label: 'Content type',
      kind: 'text',
      placeholder: 'application/json',
      showWhen: { key: 'action', equals: ['', 'fulfill'] },
    },
    { key: 'delayMs', label: 'Delay (ms)', kind: 'number' },
    { key: 'times', label: 'Only the next N requests', kind: 'number' },
  ],
  // A select, not a checkbox: an unticked box removes the key, which the step reads as "offline".
  'ui.setOffline': [
    {
      key: 'state',
      label: 'Network',
      kind: 'select',
      options: ['offline', 'online'],
      hint: 'Empty: offline',
    },
  ],
  'ui.storage': [
    { key: 'kind', label: 'Where', kind: 'select', options: ['cookie', 'local', 'session'] },
    { key: 'action', label: 'Do', kind: 'select', options: ['get', 'set', 'remove', 'clear'] },
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'value', label: 'Value', kind: 'text', showWhen: { key: 'action', equals: ['set'] } },
  ],
  'ui.setClock': [
    {
      key: 'action',
      label: 'Clock',
      kind: 'select',
      options: ['set', 'install', 'fastForward'],
      hint: 'set: fixed time · install: starts at the time and runs (before navigate) · fastForward: jump ahead',
    },
    {
      key: 'time',
      label: 'Time',
      kind: 'text',
      placeholder: '2030-01-15T10:00:00Z',
      showWhen: { key: 'action', equals: ['', 'set', 'install'] },
    },
    {
      key: 'ms',
      label: 'Forward by (ms)',
      kind: 'number',
      showWhen: { key: 'action', equals: ['fastForward'] },
    },
  ],
  'ui.swipe': [
    {
      key: 'direction',
      label: 'Direction',
      kind: 'select',
      options: ['up', 'down', 'left', 'right'],
      hint: 'With an element: swipe on it. Without: on the screen',
    },
    { key: 'percent', label: 'Distance (0–1)', kind: 'number', hint: 'Default 0.75 of the area' },
  ],
  'ui.longPress': [{ key: 'durationMs', label: 'Hold (ms)', kind: 'number', hint: 'Default 1000' }],
  'ui.scrollTo': [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['down', 'up'] },
    { key: 'maxSwipes', label: 'At most (swipes)', kind: 'number', hint: 'Default 10' },
  ],
  'ui.menu': [
    {
      key: 'path',
      label: 'Menu path',
      kind: 'text',
      placeholder: 'File > Save',
      hint: 'Menu names joined with >',
      wide: true,
    },
  ],
  'ui.rotate': [
    { key: 'orientation', label: 'Orientation', kind: 'select', options: ['landscape', 'portrait'] },
  ],
  'ui.appState': [
    {
      key: 'action',
      label: 'App',
      kind: 'select',
      options: ['launch', 'close', 'background', 'reset'],
      hint: 'background: the app comes back after the seconds below',
    },
    {
      key: 'seconds',
      label: 'Seconds in the background',
      kind: 'number',
      showWhen: { key: 'action', equals: ['background'] },
    },
  ],
  'ui.deepLink': [{ key: 'url', label: 'Link', kind: 'text', placeholder: 'myapp://orders/42', wide: true }],
  'ui.setLocation': [
    { key: 'latitude', label: 'Latitude', kind: 'number' },
    { key: 'longitude', label: 'Longitude', kind: 'number' },
  ],
  'ui.permission': [
    {
      key: 'permission',
      label: 'Permission',
      kind: 'text',
      placeholder: 'camera',
      hint: 'camera, location, microphone, contacts, photos, notifications, calendar — or a platform name',
    },
    { key: 'action', label: 'Action', kind: 'select', options: ['grant', 'revoke'] },
  ],
  'ui.pushNotification': [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'body', label: 'Text', kind: 'text', wide: true },
  ],
  'ui.networkSummary': [
    {
      key: 'since',
      label: 'Traffic since',
      kind: 'select',
      options: ['test', 'lastNavigation'],
      hint: 'Check with assertions: requests, bytes, kb, failed, thirdPartyHosts, requests:script, bytes:image…',
    },
  ],
  'ui.visualCheckpoint': [
    {
      key: 'name',
      label: 'Baseline name (optional)',
      kind: 'text',
      hint: 'Steps with the same name share a baseline',
    },
    { key: 'maxDiffPercent', label: 'Allowed difference (%)', kind: 'number', hint: 'Default 0.1' },
    { key: 'threshold', label: 'Colour tolerance (0–1)', kind: 'number', hint: 'Default 0.1' },
    { key: 'fullPage', label: 'Full page (without an element)', kind: 'checkbox' },
    {
      key: 'mask',
      label: 'Hide (CSS, comma separated)',
      kind: 'text',
      placeholder: '.clock, #ad-banner',
      wide: true,
    },
  ],
  'ui.upload': [{ key: 'files', label: 'Files (comma separated paths)', kind: 'text', wide: true }],
  'ui.switchTab': [
    { key: 'urlContains', label: 'URL contains', kind: 'text' },
    { key: 'index', label: 'or tab index', kind: 'number' },
  ],
  'ui.handleDialog': [
    { key: 'action', label: 'Action', kind: 'select', options: ['accept', 'dismiss'] },
    { key: 'promptText', label: 'Prompt text', kind: 'text' },
    {
      key: 'buttonLabel',
      label: 'Button (phone apps)',
      kind: 'text',
      placeholder: 'Allow',
      hint: 'Phone apps: answers the dialog on screen; name a button when there are more than two',
    },
  ],
  'ui.switchFrame': [
    {
      key: 'selector',
      label: 'Frame selector',
      kind: 'text',
      placeholder: '#payment-iframe',
      hint: 'A frame inside a frame: #outer >>> #inner (outermost first)',
    },
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
    { key: 'connection', label: 'Connection', kind: 'connection' },
    {
      key: 'sql',
      label: 'SQL (or a MongoDB command as JSON)',
      kind: 'code',
      language: 'sql',
      wide: true,
      hint: 'Use ? / $1 / @p1 placeholders with Parameters instead of pasting {{data.x}} into the SQL',
    },
    { key: 'params', label: 'Parameters (JSON array)', kind: 'code', language: 'json', wide: true },
    { key: 'maxRows', label: 'Max rows kept', kind: 'number' },
    { key: 'confirmProduction', label: 'Confirm writes on production (type the app name)', kind: 'text' },
  ],
  'db.mongoFind': [
    { key: 'connection', label: 'Connection', kind: 'connection' },
    { key: 'collection', label: 'Collection', kind: 'text' },
    { key: 'limit', label: 'Limit', kind: 'number' },
    { key: 'filter', label: 'Filter (JSON)', kind: 'code', language: 'json', wide: true },
    { key: 'projection', label: 'Projection (JSON)', kind: 'code', language: 'json', wide: true },
    { key: 'sort', label: 'Sort (JSON)', kind: 'code', language: 'json', wide: true },
  ],
  'db.runScript': [
    { key: 'connection', label: 'Connection', kind: 'connection' },
    {
      key: 'script',
      label: 'SQL script (statements separated by ;)',
      kind: 'code',
      language: 'sql',
      wide: true,
    },
    { key: 'confirmProduction', label: 'Confirm writes on production (type the app name)', kind: 'text' },
  ],
  'db.callProcedure': [
    { key: 'connection', label: 'Connection', kind: 'connection' },
    { key: 'procedure', label: 'Procedure name', kind: 'text', placeholder: 'refresh_totals' },
    { key: 'args', label: 'Arguments (JSON array)', kind: 'code', language: 'json', wide: true },
    { key: 'confirmProduction', label: 'Confirm on production (type the app name)', kind: 'text' },
  ],
  'db.extract': [
    {
      key: 'path',
      label: 'From the last result',
      kind: 'text',
      placeholder: 'value · rowCount · email · rows[0].id · column:id · $[0].id',
      wide: true,
    },
  ],
  'db.dataQualityCheck': [
    { key: 'connection', label: 'Connection', kind: 'connection' },
    { key: 'tables', label: 'Tables (comma-separated, empty = all)', kind: 'text', wide: true },
    { key: 'maxIssues', label: 'Issues allowed', kind: 'number', hint: 'The step fails above this' },
    {
      key: 'checks',
      label: 'Checks (JSON array)',
      kind: 'code',
      language: 'json',
      wide: true,
      hint: '["orphans","duplicates","nulls","formats","negatives"] — empty runs all',
    },
  ],
  'email.waitForEmail': [
    {
      key: 'to',
      label: 'To',
      kind: 'text',
      placeholder: '{{vars.email}}',
      hint: 'Plus-addressing keeps sign-ups unique: qa+{{run.id}}@…',
    },
    { key: 'subject', label: 'Subject contains', kind: 'text' },
    { key: 'from', label: 'From contains', kind: 'text' },
    { key: 'contains', label: 'Body contains', kind: 'text' },
    { key: 'timeoutMs', label: 'Wait up to (ms)', kind: 'number', hint: 'Default: the step timeout' },
    { key: 'inbox', label: 'Inbox', kind: 'inbox' },
    {
      key: 'since',
      label: 'Received',
      kind: 'select',
      options: ['testStart', 'any'],
      hint: 'testStart ignores older emails',
    },
  ],
  'email.assertEmail': [
    { key: 'subjectContains', label: 'Subject contains', kind: 'text' },
    { key: 'bodyContains', label: 'Body contains', kind: 'text' },
    { key: 'from', label: 'Sender contains', kind: 'text' },
    { key: 'hasLink', label: 'Has a link containing', kind: 'text', placeholder: '/verify' },
    { key: 'hasAttachment', label: 'Has an attachment named', kind: 'text', placeholder: 'invoice' },
  ],
  'email.extractFromEmail': [
    { key: 'kind', label: 'Extract', kind: 'select', options: ['otp', 'link', 'regex'] },
    { key: 'contains', label: 'Link containing (link)', kind: 'text', placeholder: '/verify' },
    { key: 'pattern', label: 'Regex (first group is kept)', kind: 'text', placeholder: 'Ref: (\\w+)' },
    { key: 'minLength', label: 'OTP min digits', kind: 'number' },
    { key: 'maxLength', label: 'OTP max digits', kind: 'number' },
  ],
  'email.openEmailLink': [
    {
      key: 'contains',
      label: 'Link containing',
      kind: 'text',
      placeholder: '/verify',
      hint: 'Opens in the test browser when one is open',
    },
    { key: 'index', label: 'Or link number (0 = first)', kind: 'number' },
  ],
  'perf.pageMetrics': [
    {
      key: 'url',
      label: 'Open first (optional)',
      kind: 'text',
      placeholder: '/dashboard',
      hint: 'Otherwise measures the current page',
    },
    { key: 'thresholds.lcpMs', label: 'LCP at most (ms)', kind: 'number', hint: 'Good: 2500' },
    { key: 'thresholds.cls', label: 'CLS at most', kind: 'number', hint: 'Good: 0.1' },
    {
      key: 'thresholds.inpMs',
      label: 'INP at most (ms)',
      kind: 'number',
      hint: 'Needs an interaction first',
    },
    { key: 'thresholds.ttfbMs', label: 'TTFB at most (ms)', kind: 'number', hint: 'Good: 800' },
    { key: 'thresholds.loadMs', label: 'Load time at most (ms)', kind: 'number' },
  ],
  'perf.lighthouse': [
    { key: 'url', label: 'Page', kind: 'text', placeholder: '/' },
    { key: 'formFactor', label: 'Device', kind: 'select', options: ['desktop', 'mobile'] },
    { key: 'thresholds.performance', label: 'Performance score at least', kind: 'number' },
    { key: 'thresholds.accessibility', label: 'Accessibility score at least', kind: 'number' },
    { key: 'thresholds.bestPractices', label: 'Best practices score at least', kind: 'number' },
    { key: 'thresholds.seo', label: 'SEO score at least', kind: 'number' },
  ],
  'perf.loadTest': [
    { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    {
      key: 'url',
      label: 'URL',
      kind: 'text',
      placeholder: '/api/products',
      wide: true,
      hint: 'Or a "requests" list (Load Designer → Save as test)',
    },
    {
      key: 'profile',
      label: 'Profile',
      kind: 'select',
      options: ['smoke', 'load', 'stress', 'spike', 'soak'],
    },
    { key: 'vus', label: 'Virtual users', kind: 'number' },
    { key: 'durationS', label: 'Duration (s)', kind: 'number' },
    { key: 'rampS', label: 'Ramp-up (s, load)', kind: 'number' },
    { key: 'thresholds.p95Ms', label: 'p95 below (ms)', kind: 'number' },
    { key: 'thresholds.p99Ms', label: 'p99 below (ms)', kind: 'number' },
    { key: 'thresholds.maxErrorRatePct', label: 'Error rate below (%)', kind: 'number' },
    { key: 'thresholds.minRps', label: 'At least (req/s)', kind: 'number' },
    { key: 'engine', label: 'Engine', kind: 'select', options: ['builtin', 'k6'] },
    { key: 'confirmProduction', label: 'Confirm production (type the app name)', kind: 'text' },
    { key: 'auth', label: 'Auth (JSON: bearer/basic/apiKey)', kind: 'code', language: 'json', wide: true },
    { key: 'body', label: 'Body (JSON)', kind: 'code', language: 'json', wide: true },
  ],
  'perf.queryPlan': [
    { key: 'connection', label: 'Connection', kind: 'connection' },
    { key: 'sql', label: 'SELECT query', kind: 'code', language: 'sql', wide: true },
    { key: 'params', label: 'Parameters (JSON array)', kind: 'code', language: 'json', wide: true },
    { key: 'maxMs', label: 'Slower than (ms) fails', kind: 'number' },
    { key: 'repeat', label: 'Runs (median)', kind: 'number' },
    { key: 'noFullScan', label: 'Fail on a full table scan', kind: 'checkbox' },
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
  'util.useData': [
    { key: 'source', label: 'Data source', kind: 'dataSource' },
    {
      key: 'pick',
      label: 'Which row',
      kind: 'select',
      options: ['first', 'random', 'unused', 'row', 'match'],
      hint: 'unused: a row no other test took in this run',
    },
    { key: 'as', label: 'Store as variable', kind: 'text', placeholder: 'defaults to the source name' },
    { key: 'row', label: 'Row number', kind: 'number', showWhen: { key: 'pick', equals: ['row'] } },
    { key: 'column', label: 'Column', kind: 'text', showWhen: { key: 'pick', equals: ['match'] } },
    { key: 'equals', label: 'Equals', kind: 'text', showWhen: { key: 'pick', equals: ['match'] } },
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
  'util.if': conditionFields('condition', 'If'),
  'util.loop': [
    {
      key: 'count',
      label: 'Repeat N times',
      kind: 'number',
      hint: 'With “repeat while”: the limit (default 100)',
    },
    { key: 'over', label: 'or for each item in', kind: 'text', placeholder: '{{vars.items}}' },
    { key: 'as', label: 'Item variable', kind: 'text', placeholder: 'item' },
    ...conditionFields('while', 'Repeat while'),
  ],
  'api.soap': [
    { key: 'url', label: 'Endpoint', kind: 'text', placeholder: '{{env.baseUrl}}/ws/prices', wide: true },
    { key: 'action', label: 'SOAPAction', kind: 'text', placeholder: 'http://example.com/GetPrice' },
    { key: 'version', label: 'SOAP version', kind: 'select', options: ['1.1', '1.2'] },
    { key: 'allowFault', label: 'A SOAP fault is expected', kind: 'checkbox' },
    {
      key: 'body',
      label: 'Body (inside soap:Body, or a whole envelope)',
      kind: 'code',
      language: 'javascript',
      wide: true,
      hint: 'Check the answer with XPath targets, e.g. //m:Price (the document’s own prefixes work)',
    },
    { key: 'header', label: 'SOAP header (optional XML)', kind: 'code', language: 'javascript', wide: true },
    { key: 'headers', label: 'HTTP headers (JSON)', kind: 'code', language: 'json', wide: true },
  ],
  'api.kafkaProduce': [
    {
      key: 'brokers',
      label: 'Brokers',
      kind: 'text',
      placeholder: '{{env.kafkaBrokers}} or localhost:9092',
      wide: true,
    },
    { key: 'topic', label: 'Topic', kind: 'text' },
    { key: 'key', label: 'Key', kind: 'text' },
    { key: 'value', label: 'Value (JSON or text)', kind: 'code', language: 'json', wide: true },
    { key: 'headers', label: 'Headers (JSON)', kind: 'code', language: 'json', wide: true },
    { key: 'ssl', label: 'TLS', kind: 'checkbox' },
    { key: 'sasl.username', label: 'SASL user', kind: 'text' },
    { key: 'sasl.password', label: 'SASL password', kind: 'text', placeholder: '{{secret.kafkaPassword}}' },
    {
      key: 'sasl.mechanism',
      label: 'SASL mechanism',
      kind: 'select',
      options: ['plain', 'scram-sha-256', 'scram-sha-512'],
    },
  ],
  'api.kafkaConsume': [
    {
      key: 'brokers',
      label: 'Brokers',
      kind: 'text',
      placeholder: '{{env.kafkaBrokers}} or localhost:9092',
      wide: true,
    },
    { key: 'topic', label: 'Topic', kind: 'text' },
    {
      key: 'since',
      label: 'Messages since',
      kind: 'select',
      options: ['testStart', 'beginning'],
      hint: 'testStart ignores messages from before this test',
    },
    { key: 'key', label: 'Key equals', kind: 'text' },
    { key: 'contains', label: 'or value contains', kind: 'text' },
    { key: 'path', label: 'or JSONPath in the value', kind: 'text', placeholder: '$.status' },
    { key: 'equals', label: 'equals', kind: 'text' },
    { key: 'timeoutMs', label: 'Wait up to (ms)', kind: 'number', hint: 'Default: the step timeout' },
    { key: 'ssl', label: 'TLS', kind: 'checkbox' },
    { key: 'sasl.username', label: 'SASL user', kind: 'text' },
    { key: 'sasl.password', label: 'SASL password', kind: 'text', placeholder: '{{secret.kafkaPassword}}' },
  ],
  'api.ftp': [
    { key: 'protocol', label: 'Protocol', kind: 'select', options: ['ftp', 'ftps', 'sftp'] },
    { key: 'host', label: 'Host', kind: 'text', placeholder: 'files.example.com' },
    { key: 'port', label: 'Port', kind: 'number', hint: 'Default 21 (FTP) / 22 (SFTP)' },
    { key: 'username', label: 'User', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'text', placeholder: '{{secret.ftpPassword}}' },
    {
      key: 'privateKey',
      label: 'or private key file (SFTP)',
      kind: 'text',
      placeholder: '/path/to/id_ed25519',
    },
    {
      key: 'action',
      label: 'Do',
      kind: 'select',
      options: ['upload', 'download', 'list', 'delete', 'exists'],
    },
    { key: 'remotePath', label: 'Remote path', kind: 'text', placeholder: '/outbox/report.csv', wide: true },
    {
      key: 'localPath',
      label: 'Local file',
      kind: 'text',
      showWhen: { key: 'action', equals: ['upload', 'download'] },
      hint: 'Upload from it; download to it (default: kept with the run)',
    },
    {
      key: 'content',
      label: 'or upload this text',
      kind: 'code',
      language: 'json',
      wide: true,
      showWhen: { key: 'action', equals: ['upload'] },
    },
  ],
  'util.manual': [
    {
      key: 'instruction',
      label: 'What the tester does',
      kind: 'text',
      placeholder: 'Print the invoice and compare it with the screen',
      wide: true,
      hint: 'Done by a person in a manual run; automated runs skip it',
    },
    {
      key: 'expected',
      label: 'Expected result',
      kind: 'text',
      placeholder: 'Both show the same total',
      wide: true,
    },
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
  'ui.tap',
  'ui.download',
  'ui.visualCheckpoint',
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
  const nested = setPath((obj[head] as Record<string, unknown>) ?? {}, rest.join('.'), value);
  // An emptied object is dropped too (e.g. clearing a loop's "while" turns it back into a plain loop).
  if (Object.keys(nested).length) copy[head] = nested;
  else delete copy[head];
  return copy;
}

/** Sets one form field's value; an emptied `clearsParent` field removes the object around it. */
export function setField(
  obj: Record<string, unknown>,
  spec: FieldSpec,
  value: unknown,
): Record<string, unknown> {
  const parent = spec.key.split('.').slice(0, -1).join('.');
  if (spec.clearsParent && parent && (value === undefined || value === ''))
    return setPath(obj, parent, undefined);
  return setPath(obj, spec.key, value);
}
