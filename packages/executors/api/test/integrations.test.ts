import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import {
  type Stats,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FtpSrv } from 'ftp-srv';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAssertions, createApiExecutor, soapFault, soapRequest } from '../src/index.ts';

/** SOAP, XML responses, FTP and SFTP against servers started in this test. */
let http: Server;
let base = '';
let ftp: FtpSrv;
let ftpPort = 0;
let sftp: InstanceType<typeof ssh2.Server>;
let sftpPort = 0;
const ftpRoot = mkdtempSync(join(tmpdir(), 'sf-ftp-'));
const sftpRoot = mkdtempSync(join(tmpdir(), 'sf-sftp-'));
/** ftp-srv logs through a bunyan-style logger; tests keep it quiet. */
const silent: Record<string, unknown> = {};
for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) silent[k] = () => {};
silent.child = () => silent;
const seen: { soapAction?: string; contentType?: string; body?: string } = {};

const PRICE = (price: string) => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://example.test/prices">
  <soap:Body><m:GetPriceResponse><m:Price currency="EUR">${price}</m:Price><m:Stock>12</m:Stock></m:GetPriceResponse></soap:Body>
</soap:Envelope>`;
const FAULT = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown item</faultstring></soap:Fault></soap:Body>
</soap:Envelope>`;

/** A minimal SFTP server on a folder (open, read, write, stat, list, remove), enough for the client's operations. */
function startSftp(root: string): Promise<number> {
  const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp;
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  sftp = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.username === 'qa' && ctx.password === 'secret'
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) =>
        accept().on('sftp', (acceptSftp) => {
          const s = acceptSftp();
          const handles = new Map<number, { fd?: number; dir?: string[] }>();
          let next = 0;
          const local = (p: string) => join(root, p.replace(/^\/+/, ''));
          const handle = (id: number) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id);
            return b;
          };
          const attrs = (st: Stats) => ({
            mode: st.mode,
            uid: 0,
            gid: 0,
            size: st.size,
            atime: Math.floor(st.atimeMs / 1000),
            mtime: Math.floor(st.mtimeMs / 1000),
          });
          s.on('REALPATH', (reqid, p) =>
            s.name(reqid, [
              {
                filename: p.startsWith('/') ? p : `/${p === '.' ? '' : p}`,
                longname: '',
                attrs: {} as never,
              },
            ]),
          );
          const stat = (reqid: number, p: string) =>
            existsSync(local(p))
              ? s.attrs(reqid, attrs(statSync(local(p))))
              : s.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          s.on('STAT', stat).on('LSTAT', stat);
          s.on('OPEN', (reqid, p, flags) => {
            const fd = openSync(local(p), flags & OPEN_MODE.WRITE ? 'w' : 'r');
            handles.set(++next, { fd });
            s.handle(reqid, handle(next));
          });
          s.on('WRITE', (reqid, h, offset, data) => {
            writeSync(handles.get(h.readUInt32BE())!.fd!, data, 0, data.length, offset);
            s.status(reqid, STATUS_CODE.OK);
          });
          s.on('READ', (reqid, h, offset, length) => {
            const buf = Buffer.alloc(length);
            const n = readSync(handles.get(h.readUInt32BE())!.fd!, buf, 0, length, offset);
            if (n === 0) s.status(reqid, STATUS_CODE.EOF);
            else s.data(reqid, buf.subarray(0, n));
          });
          s.on('FSTAT', (reqid, h) => s.attrs(reqid, attrs(fstatSync(handles.get(h.readUInt32BE())!.fd!))));
          s.on('OPENDIR', (reqid, p) => {
            handles.set(++next, { dir: readdirSync(local(p)).map((n) => join(local(p), n)) });
            s.handle(reqid, handle(next));
          });
          s.on('READDIR', (reqid, h) => {
            const entry = handles.get(h.readUInt32BE())!;
            if (!entry.dir!.length) return s.status(reqid, STATUS_CODE.EOF);
            const list = entry.dir!.splice(0).map((f) => ({
              filename: basename(f),
              longname: `${statSync(f).isDirectory() ? 'd' : '-'}rw-r--r-- 1 qa qa ${statSync(f).size} Jan 1 00:00 ${basename(f)}`,
              attrs: attrs(statSync(f)),
            }));
            s.name(reqid, list);
          });
          s.on('CLOSE', (reqid, h) => {
            const entry = handles.get(h.readUInt32BE());
            if (entry?.fd !== undefined) closeSync(entry.fd);
            handles.delete(h.readUInt32BE());
            s.status(reqid, STATUS_CODE.OK);
          });
          s.on('REMOVE', (reqid, p) => {
            rmSync(local(p));
            s.status(reqid, STATUS_CODE.OK);
          });
        }),
      ),
    );
  });
  return new Promise((r) => sftp.listen(0, '127.0.0.1', () => r((sftp.address() as AddressInfo).port)));
}

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/soap') {
        Object.assign(seen, {
          soapAction: req.headers.soapaction,
          contentType: req.headers['content-type'],
          body,
        });
        if (body.includes('<m:Item>Unknown</m:Item>'))
          return res.writeHead(500, { 'content-type': 'text/xml' }).end(FAULT);
        return res.writeHead(200, { 'content-type': 'text/xml' }).end(PRICE('1.90'));
      }
      if (req.url === '/ns.xml')
        return res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end('<orders xmlns="urn:orders"><order id="7"><total>42.50</total></order></orders>');
      if (req.url === '/orders.xml')
        return res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            '<orders><order id="7"><total>42.50</total></order><order id="8"><total>10</total></order></orders>',
          );
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  ftpPort = 20000 + Math.floor(Math.random() * 20000);
  ftp = new FtpSrv({
    url: `ftp://127.0.0.1:${ftpPort}`,
    anonymous: false,
    pasv_url: '127.0.0.1',
    pasv_min: 40000,
    pasv_max: 40100,
    log: silent as never,
  });
  ftp.on('login', ({ username, password }, resolve, reject) =>
    username === 'qa' && password === 'secret' ? resolve({ root: ftpRoot }) : reject(new Error('Bad login')),
  );
  await ftp.listen();
  sftpPort = await startSftp(sftpRoot);
});
afterAll(async () => {
  http.close();
  await ftp.close();
  sftp.close();
});

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (s: ReturnType<typeof steps>) =>
  runTestCase({
    runId: 'R',
    steps: s,
    executors: [createApiExecutor()],
    options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 8000, baseUrl: base },
    artifactsDir: mkdtempSync(join(tmpdir(), 'sf-api-')),
  });
const report = (r: Awaited<ReturnType<typeof run>>) =>
  r.steps.map((s) => `${s.type} ${s.status} ${s.message}`).join('\n');

describe('SOAP and XML', () => {
  it('wraps the body in an envelope, sends the SOAPAction, and checks the answer with XPath', async () => {
    const r = await run(
      steps(
        {
          type: 'api.soap',
          params: {
            url: '/soap',
            action: 'http://example.test/GetPrice',
            body: '<m:GetPrice xmlns:m="http://example.test/prices"><m:Item>Apple</m:Item></m:GetPrice>',
          },
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: '//m:Price', operator: 'equals', expected: '1.90' },
            { target: '//m:Price/@currency', operator: 'equals', expected: 'EUR' },
            { target: 'number(//m:Stock) > 10', operator: 'equals', expected: true },
          ],
        },
        { type: 'api.extract', params: { path: "//*[local-name()='Price']" }, captureAs: 'price' },
      ),
    );
    expect(r.status, report(r)).toBe('passed');
    expect(r.vars.price).toBe('1.90');
    expect(seen.soapAction).toBe('"http://example.test/GetPrice"');
    expect(seen.contentType).toBe('text/xml; charset=utf-8');
    expect(seen.body).toContain('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">');
  });

  it('a SOAP fault fails the step with its message (unless allowed); SOAP 1.2 uses its own content type', async () => {
    const fault = await run(
      steps({
        type: 'api.soap',
        params: { url: '/soap', body: '<m:GetPrice xmlns:m="x"><m:Item>Unknown</m:Item></m:GetPrice>' },
      }),
    );
    expect(fault.status).toBe('failed');
    expect(fault.steps[0]!.message).toContain('SOAP fault soap:Client: Unknown item');

    const allowed = await run(
      steps({
        type: 'api.soap',
        params: {
          url: '/soap',
          version: '1.2',
          action: 'urn:GetPrice',
          allowFault: true,
          body: '<m:GetPrice xmlns:m="x"><m:Item>Unknown</m:Item></m:GetPrice>',
        },
        assertions: [{ target: 'fault', operator: 'equals', expected: 'Unknown item' }],
      }),
    );
    expect(allowed.status, report(allowed)).toBe('passed');
    expect(seen.contentType).toBe('application/soap+xml; charset=utf-8; action="urn:GetPrice"');
  });

  it('XPath checks work on any XML response', async () => {
    const r = await run(
      steps({
        type: 'api.request',
        params: { url: '/orders.xml' },
        assertions: [
          { target: "//order[@id='7']/total", operator: 'equals', expected: '42.50' },
          { target: 'count(//order)', operator: 'equals', expected: 2 },
          { target: '//order/@id', operator: 'equals', expected: ['7', '8'] },
        ],
      }),
    );
    expect(r.status, report(r)).toBe('passed');
  });
});

describe('XPath namespaces and SOAP envelopes', () => {
  const ns = { o: 'urn:orders' };
  it("a request step's namespaces apply to its checks, schema checks and a later extract", async () => {
    const r = await run(
      steps(
        {
          type: 'api.request',
          params: { url: '/ns.xml', namespaces: ns },
          assertions: [
            { target: '//o:total', operator: 'equals', expected: '42.50' },
            { target: '//o:total', operator: 'matchesSchema', expected: { type: 'string', pattern: '^42' } },
          ],
        },
        { type: 'api.extract', params: { path: '//o:order/@id' }, captureAs: 'id' },
      ),
    );
    expect(r.status, report(r)).toBe('passed');
    expect(r.vars.id).toBe('7');
  });

  it('checkAssertions (the API Client) takes namespaces', () => {
    const res = { status: 200, headers: {}, text: '<a xmlns="urn:x"><b>1</b></a>', body: null } as never;
    const [eq, schema] = checkAssertions(
      res,
      [
        { target: '//x:b', operator: 'equals', expected: '1' },
        { target: '//x:b', operator: 'matchesSchema', expected: { type: 'string' } },
      ],
      { x: 'urn:x' },
    );
    expect(eq!.passed).toBe(true);
    expect(schema!.passed).toBe(true);
  });

  it('only a Fault directly in the envelope body is a SOAP fault', () => {
    const env = (inner: string) =>
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
    expect(
      soapFault(env('<m:Claim xmlns:m="x"><m:Fault>Scratch on the door</m:Fault></m:Claim>')),
    ).toBeNull();
    expect(
      soapFault(
        env('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Down</faultstring></soap:Fault>'),
      ),
    ).toEqual({ code: 'soap:Server', message: 'Down' });
  });

  it('recognises a whole envelope after a comment or DOCTYPE, and reads its SOAP version', () => {
    const v12 =
      '<!-- order lookup -->\n<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><m:Get xmlns:m="x"/></env:Body></env:Envelope>';
    const r12 = soapRequest({ body: v12, action: 'urn:Get' });
    expect(r12.xml).toBe(v12);
    expect(r12.headers['content-type']).toBe('application/soap+xml; charset=utf-8; action="urn:Get"');

    const v11 =
      '<?xml version="1.0"?>\n<!DOCTYPE note>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>';
    const r11 = soapRequest({ body: v11, action: 'urn:Get' });
    expect(r11.xml).toBe(v11);
    expect(r11.headers).toEqual({ 'content-type': 'text/xml; charset=utf-8', soapaction: '"urn:Get"' });
    // A body fragment is still wrapped.
    expect(soapRequest({ body: '<m:Get xmlns:m="x"/>' }).xml).toContain('<soap:Body><m:Get');
  });
});

describe('FTP and SFTP', () => {
  for (const protocol of ['ftp', 'sftp'] as const) {
    it(`${protocol}: upload, list, exists, download, delete`, async () => {
      const conn = {
        protocol,
        host: '127.0.0.1',
        port: protocol === 'ftp' ? ftpPort : sftpPort,
        username: 'qa',
        password: 'secret',
      };
      const r = await run(
        steps(
          {
            type: 'api.ftp',
            params: { ...conn, action: 'upload', remotePath: '/report.csv', content: 'id,total\n7,42.50\n' },
          },
          {
            type: 'api.ftp',
            params: { ...conn, action: 'list', remotePath: '/' },
            assertions: [{ target: 'names', operator: 'contains', expected: 'report.csv' }],
          },
          {
            type: 'api.ftp',
            params: { ...conn, action: 'exists', remotePath: '/report.csv' },
            assertions: [{ target: 'exists', operator: 'equals', expected: true }],
          },
          {
            type: 'api.ftp',
            params: { ...conn, action: 'download', remotePath: '/report.csv' },
            assertions: [
              { target: 'content', operator: 'contains', expected: '7,42.50' },
              { target: 'size', operator: 'equals', expected: 17 },
            ],
          },
          { type: 'api.ftp', params: { ...conn, action: 'delete', remotePath: '/report.csv' } },
          {
            type: 'api.ftp',
            params: { ...conn, action: 'exists', remotePath: '/report.csv' },
            assertions: [{ target: 'exists', operator: 'equals', expected: false }],
          },
        ),
      );
      expect(r.status, report(r)).toBe('passed');
    }, 30_000);
  }

  for (const protocol of ['ftp', 'sftp'] as const) {
    it(`${protocol}: exists for the root, folders (with or without a trailing slash) and missing parents`, async () => {
      mkdirSync(join(protocol === 'ftp' ? ftpRoot : sftpRoot, 'inbox'), { recursive: true });
      const conn = {
        protocol,
        host: '127.0.0.1',
        port: protocol === 'ftp' ? ftpPort : sftpPort,
        username: 'qa',
        password: 'secret',
        action: 'exists',
      };
      const check = (remotePath: string, expected: boolean) => ({
        type: 'api.ftp',
        params: { ...conn, remotePath },
        assertions: [{ target: 'exists', operator: 'equals' as const, expected }],
      });
      const r = await run(
        steps(
          check('/', true),
          check('/inbox', true),
          check('/inbox/', true),
          check('/no-such-folder/file.txt', false),
        ),
      );
      expect(r.status, report(r)).toBe('passed');
    }, 30_000);
  }

  it('a missing private key file is reported as such, not as a missing remote file', async () => {
    const r = await run(
      steps({
        type: 'api.ftp',
        params: {
          protocol: 'sftp',
          host: '127.0.0.1',
          port: sftpPort,
          username: 'qa',
          privateKey: join(tmpdir(), 'sf-no-such-key'),
          action: 'list',
        },
      }),
    );
    expect(r.status).not.toBe('passed');
    expect(r.steps[0]!.message).toContain('Cannot read the private key');
    expect(r.steps[0]!.errorKind).toBe('invalid_params');
  });

  it('a wrong password fails with a clear message', async () => {
    const r = await run(
      steps({
        type: 'api.ftp',
        params: {
          protocol: 'ftp',
          host: '127.0.0.1',
          port: ftpPort,
          username: 'qa',
          password: 'nope',
          action: 'list',
        },
      }),
    );
    expect(r.status).not.toBe('passed');
    expect(r.steps[0]!.message).toMatch(/ftp:\/\/127\.0\.0\.1\/\./);
  });
});
