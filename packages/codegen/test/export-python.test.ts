import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, type GeneratedProject } from '../src/index.ts';
import { pythonFeatures } from '../src/targets/python.ts';
import { KITCHEN_SINK } from './fixtures.ts';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasModule = (m: string) => hasPython && spawnSync('python3', ['-I', '-c', `import ${m}`]).status === 0;

/** Runs Python with the runtime helpers importable as `support.*` (Faker and the clients stubbed when missing). */
const python = (code: string) => {
  const root = mkdtempSync(join(tmpdir(), 'sf-py-runtime-'));
  writeFileSync(join(root, 'run.py'), code);
  return execFileSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import sys, types, importlib.util, pathlib',
        "sys.modules.setdefault('faker', types.SimpleNamespace(Faker=lambda: None))",
        "pkg = types.ModuleType('support'); pkg.__path__ = [" +
          JSON.stringify(join(import.meta.dirname, '../runtime/py')) +
          ']; sys.modules["support"] = pkg',
        `exec(pathlib.Path(${JSON.stringify(join(root, 'run.py'))}).read_text())`,
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  ).trim();
};

const file = (p: GeneratedProject, path: string) => {
  expect(Object.keys(p.files), path).toContain(path);
  return p.files[path] as string;
};

describe('Python exports of the newer steps', () => {
  it('declares what each flavour prints: everything in Playwright, no network faking in Selenium', () => {
    expect(Object.values(pythonFeatures('playwright')).every((v) => v === true)).toBe(true);
    const sel = pythonFeatures('selenium');
    for (const k of [
      'tap',
      'download',
      'offline',
      'storage',
      'pageCondition',
      'repeatWhile',
      'soap',
      'schema',
    ] as const)
      expect(sel[k], k).toBe(true);
    for (const k of ['waitResponse', 'mockRoute', 'clock', 'netSummary'] as const)
      expect(sel[k], k).toMatch(/Chrome DevTools; not exported to \{target\}/);
    expect(pythonFeatures('api').pageCondition).toBeUndefined();
    expect(pythonFeatures('api').repeatWhile).toBe(true);
    expect(pythonFeatures('appium')).toEqual({});
  });

  it('Playwright + pytest: a touch screen for taps, the recorded network, and StepForge’s loop limit', async () => {
    const p = await generate(KITCHEN_SINK, { target: 'playwright-py' });
    const t = file(p, 'tests/shop/browser/test_network_storage_and_clock.py');
    expect(t).toContain('return {**browser_context_args, "has_touch": True}');
    expect(t).toContain('network = watch_network(page.context, env["base_url"])');
    expect(t).toMatch(/network\.navigated\(\)\n\s+page\.goto\("\/products"\)/);
    expect(t).toContain(
      'raise AssertionError("Stopped after the limit of 20 pass(es); the condition still held")',
    );
    expect(t).toContain('page.clock.set_fixed_time(clock_time(1772355600000))');
    expect(file(p, 'requirements.txt')).toMatch(
      /jsonschema[\s\S]*lxml[\s\S]*kafka-python[\s\S]*paramiko[\s\S]*pymongo/,
    );
    expect(
      'support/web.py' in p.files && 'support/kafka.py' in p.files && 'support/mongo.py' in p.files,
    ).toBe(true);
  });

  it('Selenium + pytest: a touch pointer, a download folder per test, and TODOs for network faking', async () => {
    const p = await generate(KITCHEN_SINK, { target: 'selenium-py' });
    const t = file(p, 'tests/shop/browser/test_network_storage_and_clock.py');
    expect(t).toContain('browser.tap(("role", "button", "Menu"))');
    expect(t).toContain('file1 = browser.download(');
    expect(t).toContain('browser.set_offline(True)');
    expect(t).toContain(
      'TODO(StepForge): ui.mockRoute: Selenium has no way to fake responses without Chrome DevTools',
    );
    expect(file(p, 'conftest.py')).toContain('"download.default_directory": downloads');
    expect('support/web.py' in p.files).toBe(false);
  });

  it('pytest + requests: SOAP, OAuth2 and schema checks; page conditions stay TODOs', async () => {
    const p = await generate(KITCHEN_SINK, { target: 'pytest-requests' });
    const orders = file(p, 'tests/api/test_orders_api.py');
    expect(orders).toContain(
      'token1 = api.oauth2_token("https://id.test/token", "shop-tests", secret("API_TOKEN"), "orders:read")',
    );
    expect(orders).toContain('expect_schema(res2["body"]');
    expect(orders).toContain('page conditions (if the element is …) are not exported to pytest + requests');
    const soap = file(p, 'tests/api/test_integrations.py');
    expect(soap).toContain('expect_no_fault(res1["text"])');
    expect(soap).toContain('xpath_value(res1["text"], "//p:Price", {"p": "urn:prices"})');
  });
});

describe.skipIf(!hasPython)('Python runtime helpers', () => {
  it('URL patterns, clock times and the url target read as StepForge reads them', () => {
    const out = python(
      [
        'import json',
        'from support.web import url_matcher, clock_time',
        'from support.helpers import pick',
        'm = url_matcher("**/api/stock*")',
        'p = url_matcher("/api/items/*")',
        'print(json.dumps([',
        '  m("http://x.test/api/stock"), m("http://x.test/v1/api/stock?x=1"), m("http://x.test/api/other"),',
        '  p("http://x.test/api/items/7"), p("http://x.test/api/items/7/x"), url_matcher("orders")("http://x/orders/1"),',
        '  clock_time(1772355600000).isoformat(), clock_time("1772355600000").isoformat(), clock_time("2026-03-01T09:00:00Z").isoformat(),',
        '  pick({"status": 200, "headers": {}, "body": None, "text": "", "ms": 0, "size": 0, "url": "http://u"}, "url"),',
        ']))',
      ].join('\n'),
    );
    expect(JSON.parse(out)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      '2026-03-01T09:00:00+00:00',
      '2026-03-01T09:00:00+00:00',
      '2026-03-01T09:00:00+00:00',
      'http://u',
    ]);
  });

  it('Kafka messages match on key, text or a JSONPath, and checks read the value', () => {
    const out = python(
      [
        'import json, sys, types',
        "k = types.ModuleType('kafka'); k.KafkaAdminClient = k.KafkaConsumer = k.KafkaProducer = k.TopicPartition = object",
        "a = types.ModuleType('kafka.admin'); a.NewTopic = object",
        "e = types.ModuleType('kafka.errors'); e.TopicAlreadyExistsError = Exception",
        "sys.modules.update({'kafka': k, 'kafka.admin': a, 'kafka.errors': e})",
        'import importlib.util, pathlib',
        "spec = importlib.util.spec_from_file_location('support.kafka', pathlib.Path(sys.modules['support'].__path__[0]) / 'kafka.py')",
        'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
        'm = {"key": "k1", "value": {"orderId": "7", "status": "issued"}, "headers": {"source": "billing"}, "partition": 0, "offset": "3"}',
        'print(json.dumps([',
        '  mod._matches({"path": "$.orderId", "equals": 7}, m), mod._matches({"path": "$.orderId", "equals": 8}, m),',
        '  mod._matches({"key": "k2"}, m), mod._matches({"contains": "issued"}, m), mod._matches({"path": "$.missing"}, m),',
        '  mod.pick_message(m, "$.status"), mod.pick_message(m, "header:source"), mod.pick_message(m, "offset"),',
        ']))',
      ].join('\n'),
    );
    expect(JSON.parse(out)).toEqual([true, false, false, true, false, 'issued', 'billing', '3']);
  });

  it.skipIf(!hasModule('lxml'))('XPath with the document’s and the step’s prefixes, and SOAP faults', () => {
    const out = python(
      [
        'import json',
        'from support.xml import xpath_value, expect_no_fault',
        'x = \'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ns:R xmlns:ns="urn:p"><ns:Price>12.5</ns:Price><ns:L>a</ns:L><ns:L>b</ns:L></ns:R></s:Body></s:Envelope>\'',
        'f = \'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Bad</faultstring></s:Fault></s:Body></s:Envelope>\'',
        'try:\n    expect_no_fault(f)\n    fault = None\nexcept AssertionError as err:\n    fault = str(err)',
        'expect_no_fault(x)',
        'print(json.dumps([xpath_value(x, "//p:Price", {"p": "urn:p"}), xpath_value(x, "//ns:L"), xpath_value(x, "count(//ns:L)"), xpath_value(x, "//ns:None"), fault]))',
      ].join('\n'),
    );
    expect(JSON.parse(out)).toEqual(['12.5', ['a', 'b'], 2, null, 'SOAP fault s:Client: Bad']);
  });

  it.skipIf(!hasModule('jsonschema'))('JSON Schema checks with formats and OpenAPI nullable', () => {
    const out = python(
      [
        'import json',
        'from support.schema import expect_schema',
        'def run(v, s):\n    try:\n        expect_schema(v, s, "body")\n        return "ok"\n    except AssertionError as err:\n        return str(err)',
        'print(json.dumps([',
        '  run({"a": None}, {"type": "object", "properties": {"a": {"type": "string", "nullable": True}}}),',
        '  run({"e": "nope"}, {"properties": {"e": {"format": "email"}}}),',
        '  run({}, {"required": ["id"]}),',
        ']))',
      ].join('\n'),
    );
    const [nullable, email, required] = JSON.parse(out) as string[];
    expect(nullable).toBe('ok');
    expect(email).toMatch(/^body: e .*email/);
    expect(required).toBe('body: id is required but missing');
  });
});
