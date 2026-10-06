import type { CodegenInput, CodegenStep } from '../src/index.ts';

/** Builds a step with defaults, like StepForge stores them. */
const s = (type: string, extra: Partial<CodegenStep> = {}): CodegenStep => ({
  type,
  params: {},
  locators: [],
  assertions: [],
  ...extra,
});
const L = (strategy: string, value: string, name?: string) => [{ strategy, value, ...(name && { name }) }];

/** A secret VALUE that must never appear in generated code (the input only carries its name). */
export const PLANTED_SECRET = 'S3cr3t-Value-Never-Exported';

/** Every step type and option, to snapshot every generator and check that all output is valid code. */
export const KITCHEN_SINK: CodegenInput = {
  application: { name: 'Shop Desk', slug: 'shopdesk' },
  environment: {
    name: 'Staging',
    baseUrl: 'https://staging.shop.test',
    variables: { region: 'eu', 'api-version': 'v2' },
    secretKeys: ['adminPassword', 'apiToken'],
  },
  connections: [
    { name: 'main', engine: 'pg' },
    { name: 'legacy', engine: 'mssql' },
    { name: 'docs', engine: 'mongo' },
    { name: 'local', engine: 'sqlite' },
  ],
  inboxes: [
    { name: 'Team', kind: 'mailpit' },
    { name: 'Gmail', kind: 'imap' },
  ],
  blocks: {
    B1: {
      name: 'Sign in as admin',
      steps: [
        s('ui.navigate', { params: { url: '/login' } }),
        s('ui.fill', { params: { value: '{{data.user}}' }, locators: L('label', 'Email') }),
        s('ui.fill', {
          params: { value: '{{secret.adminPassword}}' },
          locators: L('placeholder', 'Password'),
        }),
        s('ui.click', { locators: L('role', 'button', 'Sign in') }),
      ],
    },
  },
  library: {
    S9: { name: 'Open the cart', steps: [s('ui.navigate', { params: { url: '/cart' } })] },
  },
  scenarios: [
    {
      id: 'S1',
      name: 'Checkout with every UI step',
      description: 'Covers the whole UI catalogue.',
      modulePath: ['Shop', 'Checkout'],
      priority: 'P1',
      tags: ['smoke', 'checkout flow'],
      preconditions: 'A product is in stock.',
      testCases: [
        {
          code: 'TC-CHE-001',
          title: 'Card payment',
          data: { user: 'ana@shop.test', qty: 2 },
          expectedResult: 'Order confirmed',
        },
        { code: 'TC-CHE-002', title: 'Voucher "SAVE10"', data: { user: 'ben@shop.test', qty: 1 } },
      ],
      steps: [
        s('util.useBlock', { label: 'Sign in', params: { blockId: 'B1' } }),
        s('util.callScenario', { params: { scenarioId: 'S9' } }),
        s('ui.navigate', {
          params: { url: '{{env.baseUrl}}/products?region={{env.region}}' },
          assertions: [{ target: 'title', operator: 'contains', expected: 'Products' }],
        }),
        s('ui.click', {
          locators: L('testId', 'product-1'),
          assertions: [{ target: 'url', operator: 'matches', expected: '/products/\\d+' }],
        }),
        s('ui.dblclick', { locators: L('text', 'Zoom image') }),
        s('ui.rightclick', { locators: L('css', '.gallery img') }),
        s('ui.hover', { locators: L('role', 'link', 'Details') }),
        s('ui.type', { params: { value: 'blue {{data.qty}}' }, locators: L('label', 'Search') }),
        s('ui.clear', { locators: L('label', 'Search') }),
        s('ui.fill', {
          params: { value: '{{data.qty}}' },
          locators: L('testId', 'qty'),
          assertions: [{ target: 'value', operator: 'equals', expected: '{{data.qty}}' }],
        }),
        s('ui.press', { params: { key: 'Enter' }, locators: L('testId', 'qty') }),
        s('ui.press', { params: { key: 'Control+A' } }),
        s('ui.select', { params: { value: 'express' }, locators: L('label', 'Shipping') }),
        s('ui.select', { params: { label: 'Gift wrap' }, locators: L('label', 'Extras') }),
        s('ui.select', { params: { index: 2 }, locators: L('label', 'Country') }),
        s('ui.check', { locators: L('role', 'checkbox', 'I agree') }),
        s('ui.uncheck', { locators: L('role', 'checkbox', 'Newsletter') }),
        s('ui.upload', { params: { files: ['fixtures/invoice.pdf'] }, locators: L('label', 'Attachment') }),
        s('ui.dragDrop', {
          locators: L('testId', 'item-a'),
          params: { target: [{ strategy: 'testId', value: 'basket' }] },
        }),
        s('ui.scroll', { params: { x: 0, y: 800 } }),
        s('ui.scroll', { locators: L('testId', 'footer') }),
        s('ui.handleDialog', { params: { action: 'accept', promptText: 'yes' } }),
        s('ui.click', { locators: L('xpath', "//button[@id='remove']") }),
        s('ui.handleDialog', { params: { action: 'dismiss' } }),
        s('ui.switchFrame', { params: { selector: 'iframe#payment' } }),
        s('ui.fill', { params: { value: '4242 4242 4242 4242' }, locators: L('placeholder', 'Card number') }),
        s('ui.switchFrame', { params: { main: true } }),
        s('ui.click', { locators: L('role', 'link', 'Terms') }),
        s('ui.switchTab', {}),
        s('ui.waitFor', { params: { loadState: 'domcontentloaded' } }),
        s('ui.closeTab'),
        s('ui.switchTab', { params: { index: 0 } }),
        s('ui.waitFor', { locators: L('testId', 'spinner'), params: { state: 'hidden' } }),
        s('ui.waitFor', { params: { url: '**/checkout/*' } }),
        s('ui.screenshot', { label: 'Order summary', params: { fullPage: true } }),
        s('ui.screenshot', { label: 'Total box', locators: L('testId', 'total') }),
        s('ui.extract', {
          params: { from: 'text', regex: '([\\d.]+)' },
          locators: L('testId', 'total'),
          captureAs: 'total',
        }),
        s('ui.extract', {
          params: { from: 'attribute', attribute: 'href' },
          locators: L('role', 'link', 'Invoice'),
          captureAs: 'invoiceUrl',
        }),
        s('ui.extract', { params: { from: 'count' }, locators: L('css', '.line-item'), captureAs: 'lines' }),
        s('ui.extract', { params: { from: 'url' }, captureAs: 'here' }),
        s('ui.assert', { params: { check: 'visible' }, locators: L('role', 'heading', 'Order confirmed') }),
        s('ui.assert', { params: { check: 'hidden' }, locators: L('testId', 'error') }),
        s('ui.assert', {
          params: { check: 'text', expected: 'Thank you, {{data.user}}!' },
          locators: L('testId', 'greeting'),
        }),
        s('ui.assert', {
          params: { check: 'textContains', expected: '{{vars.total}}' },
          locators: L('testId', 'total'),
        }),
        s('ui.assert', {
          params: { check: 'textMatches', expected: '^ORD-\\d{6}$' },
          locators: L('testId', 'order-id'),
        }),
        s('ui.assert', { params: { check: 'value', expected: 'express' }, locators: L('label', 'Shipping') }),
        s('ui.assert', { params: { check: 'count', expected: 2 }, locators: L('css', '.line-item') }),
        s('ui.assert', {
          params: { check: 'attribute', attribute: 'aria-busy', expected: 'false' },
          locators: L('testId', 'cart'),
        }),
        s('ui.assert', { params: { check: 'enabled' }, locators: L('role', 'button', 'Pay') }),
        s('ui.assert', { params: { check: 'disabled' }, locators: L('role', 'button', 'Undo') }),
        s('ui.assert', { params: { check: 'checked' }, locators: L('role', 'checkbox', 'I agree') }),
        s('ui.assert', { params: { check: 'unchecked' }, locators: L('role', 'checkbox', 'Newsletter') }),
        s('ui.assert', { params: { check: 'url', expected: '/orders/done' } }),
        s('ui.assert', { params: { check: 'urlContains', expected: 'done' } }),
        s('ui.assert', { params: { check: 'title', expected: 'Order confirmed' } }),
        s('ui.assert', { params: { check: 'titleContains', expected: 'confirmed' }, continueOnFail: true }),
        s('ui.click', {
          locators: L('testId', 'receipt'),
          assertions: [{ target: 'text', operator: 'notContains', expected: 'Error' }],
        }),
        s('ui.visualCheckpoint', { label: 'Receipt looks right' }),
        s('ui.click', { label: 'Old step', enabled: false, locators: L('testId', 'legacy') }),
      ],
    },
    {
      id: 'S2',
      name: 'Orders API',
      modulePath: ['API'],
      priority: 'P2',
      tags: ['api'],
      testCases: [],
      steps: [
        s('api.request', {
          label: 'Get a token',
          params: {
            method: 'POST',
            url: '/oauth/token',
            body: { client: 'shop', scope: 'orders' },
            bodyType: 'form',
          },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
          captureAs: 'token',
        }),
        s('api.request', {
          label: 'Create an order',
          params: {
            method: 'POST',
            url: '/api/{{env.api-version}}/orders',
            headers: { 'X-Request-Id': '{{random.uuid}}', 'X-Region': '{{env.region}}' },
            query: { dryRun: false },
            auth: { type: 'bearer', token: '{{secret.apiToken}}' },
            body: {
              items: [{ sku: 'A-1', qty: 2 }],
              note: 'it\'s "quoted" & {braced}',
              email: '{{random.email}}',
              at: '{{random.timestamp}}',
            },
          },
          assertions: [
            { target: 'status', operator: 'equals', expected: 201 },
            { target: '$.id', operator: 'exists' },
            { target: '$.items[*].sku', operator: 'contains', expected: 'A-1' },
            { target: 'header:content-type', operator: 'contains', expected: 'json' },
            { target: 'time', operator: 'lte', expected: 800 },
            { target: '$.total', operator: 'inRange', expected: [0, 1000] },
            { target: '$', operator: 'matchesSchema', expected: { type: 'object' } },
          ],
          captureAs: 'order',
        }),
        s('api.extract', { params: { from: 'header', name: 'location' }, captureAs: 'location' }),
        s('api.extract', { params: { from: 'status' }, captureAs: 'code' }),
        s('api.request', {
          label: 'Basic auth',
          params: {
            method: 'GET',
            url: '/admin',
            auth: { type: 'basic', username: 'admin', password: '{{secret.adminPassword}}' },
          },
        }),
        s('api.request', {
          label: 'API key in query',
          params: {
            method: 'GET',
            url: '/reports',
            auth: { type: 'apiKey', in: 'query', name: 'key', value: '{{secret.apiToken}}' },
          },
        }),
        s('api.request', {
          label: 'API key header',
          params: {
            method: 'DELETE',
            url: '/api/orders/{{vars.order.id}}',
            auth: { type: 'apiKey', in: 'header', name: 'x-api-key', value: '{{secret.apiToken}}' },
          },
        }),
        s('api.request', {
          label: 'Cookie',
          params: { method: 'GET', url: '/me', auth: { type: 'cookie', name: 'sid', value: 'abc' } },
        }),
        s('api.request', {
          label: 'OAuth (not exported)',
          params: { method: 'GET', url: '/x', auth: { type: 'oauth2', tokenUrl: 'https://id.test/token' } },
        }),
        s('api.request', {
          label: 'Upload',
          params: { method: 'POST', url: '/files', body: { name: 'a.txt' }, bodyType: 'multipart' },
        }),
        s('api.request', {
          label: 'Raw text',
          params: {
            method: 'PUT',
            url: 'https://other.test/raw',
            body: 'plain {{data.missing}} text',
            bodyType: 'raw',
          },
        }),
        s('api.graphql', {
          label: 'GraphQL',
          params: { url: '/graphql', query: 'query { me { id } }', variables: { first: 1 } },
          assertions: [{ target: '$.data.me.id', operator: 'isNotEmpty' }],
        }),
        s('util.if', {
          params: {
            condition: { value: '{{vars.code}}', operator: 'equals', expected: 201 },
            steps: [s('util.log', { params: { message: 'Created {{vars.order.id}}' } })],
            else: [s('util.log', { params: { message: 'Not created' } })],
          },
        }),
        s('util.loop', {
          params: {
            count: 3,
            steps: [s('api.request', { params: { method: 'GET', url: '/ping?i={{vars.index}}' } })],
          },
        }),
        s('util.loop', {
          params: {
            over: '{{vars.order.items}}',
            as: 'line',
            steps: [s('util.log', { params: { message: '{{vars.line.sku}}' } })],
          },
        }),
        s('util.setVariable', {
          params: { name: 'payload', value: { a: [1, true, null], b: '{{run.id}}' } },
        }),
        s('util.generateData', { params: { kind: 'pattern', pattern: 'ORD-####' }, captureAs: 'ref' }),
        s('util.generateData', { params: { kind: 'date', direction: 'future', days: 10 }, captureAs: 'due' }),
        s('util.wait', { params: { ms: 250 } }),
        s('util.runScript', { params: { code: 'return vars.total * 2;' }, captureAs: 'double' }),
      ],
    },
    {
      id: 'S3',
      name: 'Data and email',
      modulePath: ['Back office'],
      priority: 'P3',
      tags: [],
      testCases: [{ code: 'TC-BAC-001', title: 'Default', data: { email: 'qa@shop.test' } }],
      steps: [
        s('db.query', {
          label: 'Order count',
          params: {
            connection: 'main',
            sql: 'SELECT COUNT(*) AS n\nFROM orders\nWHERE email = $1',
            params: ['{{data.email}}'],
          },
          assertions: [
            { target: 'value', operator: 'gte', expected: 1 },
            { target: 'column:n', operator: 'noNulls' },
            { target: 'rows[0].n', operator: 'gt', expected: 0 },
          ],
          captureAs: 'counts',
        }),
        s('db.extract', { params: { path: 'value' }, captureAs: 'n' }),
        s('db.runScript', { params: { connection: 'local', script: 'DELETE FROM carts;\nVACUUM;' } }),
        s('db.callProcedure', {
          params: { connection: 'main', procedure: 'refresh_totals', args: [1, 'x'] },
        }),
        s('db.query', { params: { connection: 'legacy', sql: 'SELECT 1' } }),
        s('db.mongoFind', { params: { connection: 'docs', collection: 'orders' } }),
        s('db.dataQualityCheck', { params: { connection: 'main' } }),
        s('db.query', { params: { connection: 'unknown', sql: 'SELECT ?', params: [1] } }),
        s('email.waitForEmail', {
          params: { to: '{{data.email}}', subject: 'Your order', timeoutMs: 15000 },
          captureAs: 'mail',
        }),
        s('email.assertEmail', {
          params: {
            subjectContains: 'order',
            bodyContains: 'Thank you',
            from: 'shop@',
            hasLink: true,
            hasAttachment: 'invoice',
          },
        }),
        s('email.extractFromEmail', { params: { kind: 'otp' }, captureAs: 'otp' }),
        s('email.extractFromEmail', {
          params: { kind: 'link', contains: 'track', index: 0 },
          captureAs: 'trackUrl',
        }),
        s('email.extractFromEmail', {
          params: { kind: 'regex', pattern: 'Order (\\w+)' },
          captureAs: 'orderNo',
        }),
        s('email.openEmailLink', { params: { contains: 'track' } }),
        s('email.waitForEmail', { params: { inbox: 'Gmail', subject: 'Welcome' } }),
        s('perf.pageMetrics', {}),
        s('perf.lighthouse', { params: { url: '/' } }),
        s('perf.loadTest', { params: { url: '/api/orders' } }),
        s('perf.queryPlan', { params: { connection: 'main', sql: 'SELECT 1' } }),
      ],
    },
  ],
  author: 'Md Zarin Tasnim',
  generatedAt: '2026-10-07T12:00:00.000Z',
};
