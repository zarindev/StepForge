import { transformSync } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate, type CodegenInput, type CodegenStep } from '../src/index.ts';

/** k6, Postman and cURL: SOAP, OAuth2 client credentials, JSON Schema and "repeat while", run against a local server. */

const has = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
const SECRET = 'api-formats-client-secret'; // this test server's own credential

const s = (type: string, extra: Partial<CodegenStep> = {}): CodegenStep => ({
  type,
  params: {},
  locators: [],
  assertions: [],
  ...extra,
});

function input(sku = 'A-1'): CodegenInput {
  return {
    application: { name: 'Formats', slug: 'formats' },
    environment: {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1',
      variables: {},
      secretKeys: ['clientSecret'],
    },
    connections: [],
    inboxes: [],
    blocks: {},
    library: {},
    scenarios: [
      {
        id: 'F1',
        name: 'SOAP and OAuth2',
        modulePath: [],
        priority: 'P1',
        tags: [],
        testCases: [],
        steps: [
          s('api.soap', {
            params: {
              url: '/soap',
              action: 'urn:GetPrice',
              body: `<m:GetPrice xmlns:m="urn:prices"><m:Sku>${sku}</m:Sku></m:GetPrice>`,
            },
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: '//m:Price', operator: 'equals', expected: '12.5' },
            ],
          }),
          s('api.request', {
            params: {
              method: 'GET',
              url: '/me',
              auth: {
                type: 'oauth2',
                tokenUrl: '{{env.baseUrl}}/token',
                clientId: 'formats',
                clientSecret: '{{secret.clientSecret}}',
                scope: 'profile',
              },
            },
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: '$.name', operator: 'equals', expected: 'Ana' },
            ],
          }),
          s('util.loop', {
            params: {
              while: { value: '{{vars.index}}', operator: 'lt', expected: 3 },
              count: 5,
              steps: [s('api.request', { params: { method: 'GET', url: '/me?pass={{vars.index}}' } })],
            },
          }),
        ],
      },
    ],
    author: 'Md Zarin Tasnim',
    generatedAt: '2026-10-24T09:00:00.000Z',
  };
}

let server: Server;
let base = '';
const calls: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status: number, type: string, text: string) => {
        res.writeHead(status, { 'content-type': type });
        res.end(text);
      };
      const env = (inner: string) =>
        `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
      if (req.url === '/soap') {
        if (req.headers.soapaction !== '"urn:GetPrice"') return send(400, 'text/plain', 'no SOAPAction');
        return body.includes('<m:Sku>BAD</m:Sku>')
          ? send(
              500,
              'text/xml',
              env(
                '<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown SKU</faultstring></soap:Fault>',
              ),
            )
          : send(200, 'text/xml', env('<m:Price xmlns:m="urn:prices">12.5</m:Price>'));
      }
      if (req.url === '/token') {
        const ok =
          req.headers.authorization === `Basic ${Buffer.from(`formats:${SECRET}`).toString('base64')}` &&
          new URLSearchParams(body).get('grant_type') === 'client_credentials';
        return ok
          ? send(200, 'application/json', JSON.stringify({ access_token: 'tok-1', expires_in: 300 }))
          : send(401, 'application/json', '{"error":"invalid_client"}');
      }
      if (req.url?.startsWith('/me'))
        return req.headers.authorization === 'Bearer tok-1' || req.url.includes('pass=')
          ? send(200, 'application/json', '{"name":"Ana"}')
          : send(401, 'application/json', '{}');
      send(404, 'text/plain', 'not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

/** Writes the generated project and runs its command; the exit status and output. */
async function runProject(target: 'curl' | 'k6', secret: string, sku?: string) {
  const project = await generate(input(sku), { target });
  const dir = mkdtempSync(join(tmpdir(), `sf-${target}-`));
  for (const [path, content] of Object.entries(project.files))
    writeFileSync(join(dir, path.replace(/\//g, '_')), content);
  const env = { ...process.env, BASE_URL: base, CLIENT_SECRET: secret };
  // Asynchronous: the test server answers from this same process.
  const [cmd, args] =
    target === 'curl'
      ? ['bash', [join(dir, 'requests.sh')]]
      : ['k6', ['run', '--quiet', join(dir, 'script.js')]];
  return new Promise<{ status: number | null; out: string; project: typeof project }>((done) => {
    const child = spawn(cmd as string, args as string[], { env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => done({ status, out, project }));
  });
}

describe('k6, Postman and cURL', () => {
  it('print SOAP, OAuth2 and (k6) repeat-while; XPath checks and what they cannot run stay TODOs with warnings', async () => {
    for (const target of ['k6', 'postman', 'curl'] as const) {
      const p = await generate(input(), { target });
      const text = Object.values(p.files).join('\n');
      expect(text, target).toContain('urn:GetPrice');
      expect(text, target).toContain('TODO(StepForge): check //m:Price equals');
      expect(text, target).not.toContain(SECRET);
      expect(
        p.warnings.map((w) => w.message),
        target,
      ).toContainEqual(expect.stringContaining('XPath checks'));
      const loops = p.warnings.some((w) => w.message.includes('“repeat while” loops are not exported'));
      expect(loops, target).toBe(target !== 'k6');
    }
    const k6 = (await generate(input(), { target: 'k6' })).files['script.js'] as string;
    expect(() => transformSync(k6, { loader: 'js', format: 'esm' })).not.toThrow();
    expect(k6).toMatch(/oauth2Token\(\{\s*tokenUrl: url\(`\$\{env.baseUrl\}\/token`\)/);
    expect(k6).toContain("'Stopped after the limit of 5 pass(es); the condition still held'");
    const pm = JSON.parse(
      (await generate(input(), { target: 'postman' })).files['formats.postman_collection.json'] as string,
    );
    const exec = JSON.stringify(pm);
    expect(exec).toContain('pm.sendRequest(');
    expect(exec).toContain('Bearer {{oauth2Token}}');
    expect(exec).toContain('no SOAP fault');
  });

  it('keep a Postman JSON Schema check, with OpenAPI nullable read as StepForge reads it', async () => {
    const i = input();
    i.scenarios[0]!.steps[1]!.assertions.push({
      target: '$',
      operator: 'matchesSchema',
      expected: { type: 'object', properties: { name: { type: 'string', nullable: true } } },
    });
    const pm = (await generate(i, { target: 'postman' })).files['formats.postman_collection.json'] as string;
    expect(pm).toContain('\\"type\\":[\\"string\\",\\"null\\"]');
    const k6 = await generate(i, { target: 'k6' });
    expect(k6.warnings.map((w) => w.message)).toContain(
      'the JSON Schema check on "$" is not exported to k6 script (it has no JSON Schema validator)',
    );
  });

  it.skipIf(!has('bash'))('the cURL script passes bash -n', async () => {
    const p = await generate(input(), { target: 'curl' });
    const dir = mkdtempSync(join(tmpdir(), 'sf-curl-n-'));
    writeFileSync(join(dir, 'requests.sh'), p.files['requests.sh'] as string);
    expect(spawnSync('bash', ['-n', join(dir, 'requests.sh')]).status).toBe(0);
  });

  it.skipIf(!has('bash') || !has('curl') || !has('jq'))(
    'the cURL script runs: passes as written, fails on a SOAP fault and on a wrong client secret',
    async () => {
      const ok = await runProject('curl', SECRET);
      expect(ok.out).toContain('✓ no SOAP fault');
      expect(ok.out).toContain('All checks passed');
      expect(ok.status).toBe(0);
      const fault = await runProject('curl', SECRET, 'BAD');
      expect(fault.out).toContain('✗ no SOAP fault (got: Unknown SKU)');
      expect(fault.status).toBe(1);
      const token = await runProject('curl', 'wrong');
      expect(token.out).toContain('✗ OAuth2 token from');
      expect(token.status).toBe(1);
    },
    60_000,
  );

  it.skipIf(!has('k6'))(
    'the k6 script runs: passes as written, loops while the condition holds, fails on a fault or a wrong secret',
    async () => {
      calls.length = 0;
      const ok = await runProject('k6', SECRET);
      expect(ok.status, ok.out).toBe(0);
      // Three passes (index 0, 1, 2), then the condition no longer holds.
      expect(calls.filter((c) => c.startsWith('GET /me?pass='))).toEqual([
        'GET /me?pass=0',
        'GET /me?pass=1',
        'GET /me?pass=2',
      ]);
      expect(calls.filter((c) => c === 'POST /token')).toHaveLength(1);
      expect((await runProject('k6', SECRET, 'BAD')).status).not.toBe(0);
      expect((await runProject('k6', 'wrong')).status).not.toBe(0);
    },
    60_000,
  );
});
