import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type StepForgeDb } from '../src/index.ts';
import * as r from '../src/repos/index.ts';

/** Regression tests: references that must survive renames, deletes, nesting and export/import. */
let db: StepForgeDb;
let appId = '';
let moduleId = '';
beforeEach(() => {
  db = openDatabase({ file: ':memory:' }).db;
  appId = r.createApplication(db, { name: 'CareClinic', slug: 'careclinic' }).id;
  moduleId = r.createModule(db, appId, { name: 'Patients' }).id;
});

const css = (value: string) => ({ strategy: 'css', value });
const click = (locators: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'ui.click',
  locators,
  ...extra,
});
const yes = { value: 1, operator: 'equals', expected: 1 };

describe('step owner of nested steps', () => {
  it('finds steps inside if/loop by the run’s synthetic ids, in scenarios and blocks', () => {
    const s = r.createScenario(db, moduleId, {
      name: 'Nested',
      steps: [
        {
          type: 'util.if',
          params: { condition: yes, steps: [click([css('#then')])], else: [click([css('#else')])] },
        },
        { type: 'util.loop', params: { count: 2, steps: [click([css('#loop')])] } },
      ] as never,
    });
    const [ifStep, loopStep] = s.steps;
    expect(r.stepOwner(db, s.id, `${ifStep!.id}:t0`)).toMatchObject({
      kind: 'scenario',
      stepId: `${ifStep!.id}:t0`,
    });
    expect(r.stepOwner(db, s.id, `${ifStep!.id}:e0`).kind).toBe('scenario');
    expect(r.stepOwner(db, s.id, `${loopStep!.id}:l0`).kind).toBe('scenario');
    expect(() => r.stepOwner(db, s.id, `${ifStep!.id}:t5`)).toThrow();

    const fixed = r.acceptLocator(db, s.id, `${ifStep!.id}:e0`, css('#better'));
    const elseStep = (fixed.scenario!.steps[0]!.params as { else: { locators: unknown[] }[] }).else[0]!;
    expect(elseStep.locators).toEqual([css('#better'), css('#else')]);

    const b = r.createBlock(db, appId, {
      name: 'Inner',
      steps: [{ type: 'util.if', params: { condition: yes, steps: [click([css('#b')])] } }] as never,
    });
    const user = r.createScenario(db, moduleId, {
      name: 'Uses block',
      steps: [{ type: 'util.useBlock', params: { blockId: b.id } }] as never,
    });
    const owner = r.stepOwner(db, user.id, `${user.steps[0]!.id}>${b.steps[0]!.id}:t0`);
    expect(owner).toMatchObject({ kind: 'block', id: b.id });
    const blockFix = r.acceptLocator(db, user.id, `${user.steps[0]!.id}>${b.steps[0]!.id}:t0`, css('#b2'));
    expect(
      (blockFix.block!.steps[0]!.params as { steps: { locators: unknown[] }[] }).steps[0]!.locators,
    ).toEqual([css('#b2'), css('#b')]);
  });

  it('accepting a locator drops refs to deleted elements', () => {
    const gone = r.createElement(db, appId, { name: 'Gone', locators: [css('#gone')] as never });
    const s = r.createScenario(db, moduleId, {
      name: 'Dead ref',
      steps: [click([{ strategy: 'element', value: gone.id }, css('#fallback')])] as never,
    });
    r.deleteElement(db, gone.id);
    const owner = r.stepOwner(db, s.id, s.steps[0]!.id);
    expect(owner.element).toBeUndefined();
    const fixed = r.acceptLocator(db, s.id, s.steps[0]!.id, css('#new'));
    expect(fixed.scenario!.steps[0]!.locators).toEqual([css('#new'), css('#fallback')]);
  });
});

describe('environments and campaigns', () => {
  it('deleting an environment removes it from campaigns; export/import skips campaigns left without one', () => {
    const local = r.createEnvironment(db, appId, { name: 'Local', baseUrl: 'http://localhost' });
    const staging = r.createEnvironment(db, appId, { name: 'Staging', baseUrl: 'http://staging' });
    const both = r.saveCampaign(db, appId, { name: 'Both', environmentIds: [local.id, staging.id] });
    const onlyStaging = r.saveCampaign(db, appId, { name: 'Staging only', environmentIds: [staging.id] });
    r.deleteEnvironment(db, staging.id);
    expect(r.getCampaign(db, both.id).environmentIdsJson).toEqual([local.id]);
    expect(r.getCampaign(db, onlyStaging.id).environmentIdsJson).toEqual([]);
    // Editing works again once an environment is chosen.
    r.saveCampaign(db, appId, { name: 'Both', environmentIds: [local.id] }, both.id);

    const exported = r.exportApplication(db, appId);
    const imported = r.importApplication(db, exported, { slug: 'careclinic-copy' });
    expect(imported.counts.campaigns).toBe(1);
    expect(imported.warnings).toEqual(['Campaign "Staging only" was not imported: it has no environment']);
    expect(r.listCampaigns(db, imported.applicationId).map((c) => c.name)).toEqual(['Both']);
  });

  it('an export never carries passwords typed into browser settings (placeholders are kept)', () => {
    r.createEnvironment(db, appId, {
      name: 'Proxy',
      baseUrl: 'http://localhost',
      browserDefaults: {
        browser: 'chromium',
        headless: true,
        settings: {
          httpCredentials: { username: 'ana', password: 'Plain-Pass-1' },
          proxy: { server: 'http://proxy:8080', password: '{{secret.proxyPw}}' },
          clientCertificates: [{ origin: 'https://x', pfxPath: 'c.pfx', passphrase: 'Pfx-Pass-2' }],
        },
      },
    });
    const text = JSON.stringify(r.exportApplication(db, appId));
    expect(text).not.toContain('Plain-Pass-1');
    expect(text).not.toContain('Pfx-Pass-2');
    expect(text).toContain('{{secret.proxyPw}}');
    expect(text).toContain('"username":"ana"');
  });

  it('a campaign run without runs is never reported as passed', () => {
    const local = r.createEnvironment(db, appId, { name: 'Local', baseUrl: 'http://localhost' });
    const c = r.saveCampaign(db, appId, { name: 'C', environmentIds: [local.id] });
    const run = r.createCampaignRun(db, c, { trigger: 'manual' });
    expect(r.summarizeCampaignRun(db, run).status).not.toBe('passed');
  });
});

describe('import', () => {
  it('rewrites scenario calls inside blocks (nested too) to the imported scenarios', () => {
    const target = r.createScenario(db, moduleId, { name: 'Target' });
    const b = r.createBlock(db, appId, {
      name: 'Calls',
      steps: [
        { type: 'util.callScenario', params: { scenarioId: target.id } },
        {
          type: 'util.if',
          params: {
            condition: yes,
            steps: [{ type: 'util.callScenario', params: { scenarioId: target.id } }],
          },
        },
      ] as never,
    });
    expect(b.steps).toHaveLength(2);
    const imported = r.importApplication(db, r.exportApplication(db, appId), { slug: 'careclinic-copy' });
    const tree = r.getTree(db, imported.applicationId);
    const newTarget = tree.scenarios.find((s) => s.name === 'Target')!.id;
    const block = r.getBlock(db, r.listBlocks(db, imported.applicationId)[0]!.id);
    expect(block.steps[0]!.params).toMatchObject({ scenarioId: newTarget });
    expect((block.steps[1]!.params as { steps: { params: unknown }[] }).steps[0]!.params).toMatchObject({
      scenarioId: newTarget,
    });
  });
});

describe('hooks', () => {
  it('refuses a hook block with an input that has no default, and adding one to a block used as a hook', () => {
    const needs = r.createBlock(db, appId, { name: 'Sign in as', inputs: [{ name: 'user' }] });
    expect(() => r.updateModule(db, moduleId, { setupBlockId: needs.id })).toThrow(
      /cannot be a hook: its input "user" has no default/,
    );
    expect(() => r.createScenario(db, moduleId, { name: 'X', teardownBlockId: needs.id } as never)).toThrow(
      /cannot be a hook/,
    );
    const ok = r.createBlock(db, appId, { name: 'Sign in', inputs: [{ name: 'user', default: 'admin' }] });
    r.updateModule(db, moduleId, { setupBlockId: ok.id });
    expect(() => r.updateBlock(db, ok.id, { inputs: [{ name: 'user' }] })).toThrow(/runs as a hook/);
    expect(r.updateBlock(db, ok.id, { inputs: [{ name: 'user', default: 'root' }] }).inputsJson).toEqual([
      { name: 'user', default: 'root' },
    ]);
  });
});

describe('data sources', () => {
  it('renaming a source rewrites util.useData steps in scenarios and blocks, nested too', () => {
    const src = r.createDataSource(db, appId, { name: 'users', kind: 'table', columns: ['a'] });
    const use = { type: 'util.useData', params: { source: 'users' } };
    const s = r.createScenario(db, moduleId, {
      name: 'Reads',
      steps: [use, { type: 'util.loop', params: { count: 1, steps: [use] } }] as never,
    });
    const b = r.createBlock(db, appId, { name: 'B', steps: [use] as never });
    r.updateDataSource(db, src.id, { name: 'people', kind: 'table', columns: ['a'] });
    const after = r.getScenario(db, s.id);
    expect(after.steps[0]!.params).toMatchObject({ source: 'people' });
    expect((after.steps[1]!.params as { steps: { params: unknown }[] }).steps[0]!.params).toMatchObject({
      source: 'people',
    });
    expect(r.getBlock(db, b.id).steps[0]!.params).toMatchObject({ source: 'people' });
    expect(r.listDataSources(db, appId)[0]!.usedBySteps).toBe(3);
  });
});
