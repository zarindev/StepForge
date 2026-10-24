import { describe, expect, it } from 'vitest';
import { generate } from '../src/index.ts';
import { javaFeatures } from '../src/targets/java.ts';
import { HOSTILE, KITCHEN_SINK } from './fixtures.ts';

const files = async (target: 'selenium-java' | 'rest-assured', input = KITCHEN_SINK) =>
  (await generate(input, { target })).files as Record<string, string>;

describe('Java exports: newer steps', () => {
  it('declares what each flavour prints, with a reason for what Selenium cannot do', () => {
    expect(javaFeatures('appium')).toEqual({});
    const api = javaFeatures('api');
    expect(Object.keys(api).sort()).toEqual(
      ['ftp', 'kafka', 'mongo', 'oauth2', 'repeatWhile', 'schema', 'soap'].sort(),
    );
    const selenium = javaFeatures('selenium');
    for (const f of ['tap', 'download', 'storage', 'pageCondition', 'repeatWhile', 'soap', 'kafka'] as const)
      expect(selenium[f], f).toBe(true);
    for (const f of ['waitResponse', 'mockRoute', 'netSummary', 'offline', 'clock'] as const)
      expect(selenium[f], f).toMatch(/is not exported to \{target\}: WebDriver/);
  });

  it('Selenium: taps with a touch pointer, downloads, storage, page conditions and the loop limit', async () => {
    const f = await files('selenium-java');
    const browser = f['src/test/java/tests/shop/browser/NetworkStorageAndClockTest.java']!;
    expect(browser).toContain('browser.tap(Loc.of("role", "button", "Menu"));');
    expect(browser).toContain(
      'Browser.Download file1 = browser.download(Loc.of("role", "link", "Export CSV"));',
    );
    expect(browser).toContain('check(file1.content(), "contains", "sku", "content contains");');
    expect(browser).toContain('Browser.Stored stored1 = browser.storage("cookie", "get", "consent", null);');
    expect(browser).toContain('browser.storage("local", "set", "cart", "{\\"items\\":2}");');
    expect(browser).toContain(
      'if (browser.condition(Loc.of("role", "button", "Accept cookies"), "visible", null, 1000)) {',
    );
    expect(browser).toContain(
      'if (pass1 >= 20) throw new AssertionError("Stopped after the limit of 20 pass(es); the condition still held");',
    );
    expect(browser).toContain(
      'TODO(StepForge): ui.mockRoute: faking a route is not exported to Selenium + JUnit 5',
    );
    // The browser keeps downloads in a folder of the test, without asking.
    expect(f['src/test/java/support/BrowserTest.java']).toContain('"download.default_directory"');
  });

  it('REST Assured: SOAP with XPath and faults, OAuth2, JSON Schema, Kafka, FTP and MongoDB', async () => {
    const f = await files('rest-assured');
    const integrations = f['src/test/java/tests/api/IntegrationsTest.java']!;
    expect(integrations).toContain('Xml.expectNoFault(res1.text());');
    expect(integrations).toContain(
      'check(Xml.value(res1.text(), "//p:Price", J.map("p", "urn:prices")), "gt", 0',
    );
    // allowFault: no fault check on the 1.2 envelope.
    expect(integrations.match(/expectNoFault/g)).toHaveLength(1);
    expect(integrations).toContain('Kafka.consume(J.map("brokers", "localhost:9092", "topic", "invoices"');
    expect(integrations).toContain('testStart, 20000);');
    expect(integrations).toContain('check(ftp2.get("content"), "contains", "A-1", "content contains");');
    const orders = f['src/test/java/tests/api/OrdersApiTest.java']!;
    expect(orders).toContain(
      '.header("Authorization", "Bearer " + Api.oauth2Token("https://id.test/token", "shop-tests", Config.secret("API_TOKEN"), "orders:read"))',
    );
    expect(orders).toContain(
      'Schema.expect(res2.body(), J.map("type", "object"), "$ matches the JSON schema");',
    );
    expect(f['src/test/java/tests/back_office/DataAndEmailTest.java']).toContain(
      'Db.Result db4 = Mongo.run("docs", J.map(',
    );
    const pom = f['pom.xml']!;
    for (const a of ['json-schema-validator', 'kafka-clients', 'commons-net', 'jsch', 'mongodb-driver-sync'])
      expect(pom, a).toContain(`<artifactId>${a}</artifactId>`);
    for (const h of ['Xml', 'Schema', 'Kafka', 'Ftp', 'Mongo'])
      expect(Object.keys(f)).toContain(`src/test/java/support/${h}.java`);
    // Secrets are read from the environment, never written.
    expect(integrations).toContain('Config.secret("ADMIN_PASSWORD")');
  });

  it('adds the libraries and helpers only to projects that use them', async () => {
    const f = await files('rest-assured', HOSTILE);
    for (const a of ['json-schema-validator', 'kafka-clients', 'commons-net', 'jsch', 'mongodb-driver-sync'])
      expect(f['pom.xml'], a).not.toContain(a);
    for (const h of ['Xml', 'Schema', 'Kafka', 'Ftp', 'Mongo'])
      expect(Object.keys(f)).not.toContain(`src/test/java/support/${h}.java`);
  });
});
