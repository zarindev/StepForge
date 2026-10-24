import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/index.ts';
import { KITCHEN_SINK, PLANTED_SECRET } from './fixtures.ts';

/** The Cypress export of the newer steps (by Md Zarin Tasnim): what it prints, and what stays a TODO and why. */
describe('Cypress: newer steps', async () => {
  const project = await generate(KITCHEN_SINK, { target: 'cypress-js', ci: ['github'] });
  const files = project.files as Record<string, string>;
  // Compared with spaces and line breaks collapsed: Prettier decides where the lines break.
  const flat = (x: string) => x.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ');
  const browser = flat(files['cypress/e2e/shop/browser/network-storage-and-clock.cy.js']!);
  const orders = flat(files['cypress/e2e/api/orders-api.cy.js']!);
  const integrations = flat(files['cypress/e2e/api/integrations.cy.js']!);
  const data = flat(files['cypress/e2e/back-office/data-and-email.cy.js']!);

  it('fakes routes, waits for responses recorded from the start of the test, and reads storage and downloads', () => {
    // The recorder comes first, before the page opens.
    expect(browser.indexOf('watchNetwork();')).toBeLessThan(browser.indexOf('cy.visit('));
    expect(browser).toContain("mockRoute({ url: '/api/ads', action: 'abort' });");
    expect(browser).toContain("mockRoute({ url: '/api/slow', action: 'delay', delayMs: 500, times: 2 });");
    expect(browser).toContain("mockRoute({ url: '**/api/stock*', action: 'remove' });");
    expect(browser).toContain(
      "waitForResponse({ url: '/api/products', method: 'GET', status: 200, timeoutMs: 15000 }).then((res) => {",
    );
    expect(browser).toContain("check(pick(res, 'url'), 'contains', '/api/products', 'url contains');");
    expect(browser).toContain(
      "download(() => cy.findByRole('link', { name: 'Export CSV' })).then((file) => {",
    );
    expect(browser).toContain("check(file.content, 'contains', 'sku', 'content contains');");
    expect(browser).toContain(
      "storage({ kind: 'local', action: 'set', name: 'cart', value: '{\"items\":2}' });",
    );
    expect(browser).toContain("check(stored.value, 'equals', 'yes', 'value equals');");
    // A tap fires the touch events, then the click.
    expect(browser).toContain(".trigger('touchstart').trigger('touchend').click();");
    // Only a fixed clock is the same in Cypress.
    expect(browser).toContain('fixClock(new Date(1772355600000));');
    expect(files['cypress.config.js']).toContain('...downloadTasks(config.downloadsFolder),');
  });

  it('chooses branches and repeats passes once the page check has a result, with StepForge’s limit', () => {
    expect(browser).toContain(
      "cy.then(() => pageCondition(byRole('button', 'Accept cookies'), 'visible', undefined, 1000)).then(",
    );
    expect(browser).toContain("pageCondition(byCss('.product-card'), 'count', 12)");
    expect(browser).toContain(
      "if (pass >= 20) throw new Error('Stopped after the limit of 20 pass(es); the condition still held');",
    );
    expect(browser).toContain('cy.then(() => pass1(pass + 1));');
    // A value condition in a loop, and a page condition in an API scenario.
    expect(orders).toContain("if (!compare(vars.index, 'lt', 3)) return;");
    expect(orders).toContain("pageCondition(byText('Out of stock'), 'present')");
  });

  it('sends SOAP, fetches OAuth2 tokens and checks JSON Schemas', () => {
    expect(integrations).toContain('expectNoFault(res.text);');
    expect(integrations).toContain("xpathValue(res.text, '//p:Price', { p: 'urn:prices' })");
    expect(integrations).toContain('soapaction: \'"urn:GetPrice"\'');
    // The 1.2 envelope allows a fault: no fault check.
    expect(integrations.match(/expectNoFault\(/g)).toHaveLength(1);
    expect(orders).toContain("oauth2Token({ tokenUrl: 'https://id.test/token', clientId: 'shop-tests'");
    expect(orders).toContain('Authorization: `Bearer ${token}`');
    expect(orders).toContain('expectSchema(res.body,');
    expect(files['cypress/support/api.js']).toContain("grant_type: 'client_credentials'");
    expect(files['package.json']).toContain('"ajv": "^8.17.1"');
  });

  it('runs Kafka, FTP and MongoDB in Node tasks bundled without the test-data helpers', () => {
    expect(integrations).toContain("cy.task('kafka:consume',");
    expect(integrations).toContain('since: testStart');
    expect(integrations).toContain("cy.task('ftp',");
    expect(data).toContain("cy.task('mongo:run', {");
    for (const p of ['kafka', 'ftp', 'mongo']) {
      expect(files[`cypress/plugins/${p}.cjs`], p).not.toContain('@faker-js/faker');
      expect(() =>
        transformSync(files[`cypress/plugins/${p}.cjs`]!, { loader: 'js', format: 'cjs' }),
      ).not.toThrow();
    }
    expect(JSON.parse(files['package.json']!).devDependencies).toMatchObject({
      kafkajs: '^2.2.4',
      'basic-ftp': '^6.2.3',
      mongodb: '^7.7.0',
      '@testing-library/dom': '^10.4.0',
    });
    for (const text of Object.values(files)) expect(text).not.toContain(PLANTED_SECRET);
  });

  it('keeps offline mode, the network summary and a running clock as TODOs, with the reason', () => {
    const messages = project.warnings.map((w) => `${w.step ?? ''}: ${w.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ui\.setOffline: going offline is not exported to Cypress/),
        expect.stringMatching(/^ui\.networkSummary: the network summary is not exported to Cypress/),
        'ui.setClock: a page clock that runs on from a set time is not exported to Cypress (cy.clock stops time); fix the time instead',
        'ui.setClock: moving the page clock forward is not exported to Cypress (cy.tick needs a stopped clock)',
      ]),
    );
    expect(browser).toContain('// TODO(StepForge): ui.setClock (install)');
  });
});
