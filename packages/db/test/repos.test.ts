import { generateKey } from '@stepforge/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, schema, type StepForgeDb } from '../src/index.ts';
import * as r from '../src/repos/index.ts';

let db: StepForgeDb;
const key = generateKey();
beforeEach(() => {
  db = openDatabase({ file: ':memory:' }).db;
});

const app = () => r.createApplication(db, { name: 'CareClinic', slug: 'careclinic' });

describe('applications', () => {
  it('creates, summarises, updates and rejects duplicate slugs', () => {
    const a = app();
    expect(a.counts).toMatchObject({ environments: 0, scenarios: 0 });
    expect(() => r.createApplication(db, { name: 'X', slug: 'careclinic' })).toThrow(/already exists/);
    expect(r.updateApplication(db, a.id, { description: 'Clinic demo' }).description).toBe('Clinic demo');
    expect(r.listApplications(db)).toHaveLength(1);
    r.updateApplication(db, a.id, { archived: true });
    expect(r.listApplications(db)).toHaveLength(0);
    expect(r.listApplications(db, { includeArchived: true })).toHaveLength(1);
  });

  it('delete removes the whole tree', () => {
    const a = app();
    const m = r.createModule(db, a.id, { name: 'Patients' });
    r.createModule(db, a.id, { name: 'Registration', parentId: m.id });
    const s = r.createScenario(db, m.id, { name: 'Register patient' });
    r.createTestCase(db, s.id, { title: 'Valid' });
    r.deleteApplication(db, a.id);
    for (const t of [schema.modules, schema.scenarios, schema.testCases, schema.steps]) {
      expect(db.select().from(t).all()).toHaveLength(0);
    }
  });
});

describe('environments and secrets', () => {
  it('stores secrets encrypted and never returns plaintext', () => {
    const a = app();
    const env = r.createEnvironment(db, a.id, {
      name: 'Local',
      baseUrl: 'http://localhost:8101',
      isProduction: false,
    });
    const meta = r.setSecret(db, key, env.id, { key: 'adminPassword', value: 'hunter2!' });
    expect(JSON.stringify(meta)).not.toContain('hunter2');
    expect(JSON.stringify(db.select().from(schema.secrets).all())).not.toContain('hunter2');
    r.setSecret(db, key, env.id, { key: 'adminPassword', value: 'changed' }); // upsert
    expect(r.listSecrets(db, env.id)).toHaveLength(1);
    expect(r.resolveSecrets(db, key, env.id)).toEqual({ adminPassword: 'changed' });
    expect(r.getApplication(db, a.id).hasProduction).toBe(false);
    r.updateEnvironment(db, env.id, { isProduction: true });
    expect(r.getApplication(db, a.id).hasProduction).toBe(true);
  });

  it('validates base URLs and secret keys', () => {
    const a = app();
    expect(() => r.createEnvironment(db, a.id, { name: 'x', baseUrl: 'not a url' })).toThrow();
    const env = r.createEnvironment(db, a.id, { name: 'x', baseUrl: 'http://x.test' });
    expect(() => r.setSecret(db, key, env.id, { key: 'bad key', value: 'v' })).toThrow();
  });
});

describe('modules', () => {
  it('nests, orders and prevents cycles', () => {
    const a = app();
    const p = r.createModule(db, a.id, { name: 'Patients' });
    const c = r.createModule(db, a.id, { name: 'Registration', parentId: p.id });
    const g = r.createModule(db, a.id, { name: 'Validation', parentId: c.id });
    const b = r.createModule(db, a.id, { name: 'Billing' });
    expect(b.sortOrder).toBe(1);
    expect(r.descendantIds(db, p.id).sort()).toEqual([c.id, g.id].sort());
    expect(() => r.updateModule(db, p.id, { parentId: g.id })).toThrow(/inside itself/);
    expect(() => r.updateModule(db, p.id, { parentId: p.id })).toThrow(/inside itself/);
    expect(r.updateModule(db, g.id, { parentId: null }).parentId).toBeNull();
  });

  it('rejects parents from another application', () => {
    const a = app();
    const other = r.createApplication(db, { name: 'Shop', slug: 'shop' });
    const m = r.createModule(db, other.id, { name: 'Sales' });
    expect(() => r.createModule(db, a.id, { name: 'x', parentId: m.id })).toThrow(/different application/);
  });

  it('deleting a module removes sub-modules and scenarios', () => {
    const a = app();
    const p = r.createModule(db, a.id, { name: 'Patients' });
    const c = r.createModule(db, a.id, { name: 'Registration', parentId: p.id });
    r.createScenario(db, c.id, { name: 'S' });
    r.deleteModule(db, p.id);
    expect(db.select().from(schema.modules).all()).toHaveLength(0);
    expect(db.select().from(schema.scenarios).all()).toHaveLength(0);
  });
});

describe('scenarios, steps and versions', () => {
  it('derives kind, keeps step ids and records versions', () => {
    const a = app();
    const m = r.createModule(db, a.id, { name: 'Patients' });
    const s = r.createScenario(db, m.id, {
      name: 'Register',
      steps: [{ type: 'ui.navigate', params: { url: '/' } }],
    });
    expect(s.kind).toBe('ui');
    expect(s.version).toBe(1);
    const stepId = s.steps[0]!.id;

    const s2 = r.saveSteps(db, s.id, [
      { ...s.steps[0]!, label: 'Open home' },
      { type: 'api.request', params: { method: 'GET', url: '/api/patients' } },
    ]);
    expect(s2.kind).toBe('hybrid');
    expect(s2.version).toBe(2);
    expect(s2.steps[0]!.id).toBe(stepId);
    expect(s2.steps.map((x) => x.type)).toEqual(['ui.navigate', 'api.request']);

    const s3 = r.updateScenario(db, s.id, { priority: 'P1' });
    expect(s3.version).toBe(3);
    expect(r.updateScenario(db, s.id, { priority: 'P1' }).version).toBe(3); // no-op change → no version

    const versions = r.listVersions(db, s.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);

    const restored = r.restoreVersion(db, s.id, 1);
    expect(restored.version).toBe(4);
    expect(restored.steps).toHaveLength(1);
    expect(restored.priority).toBe('P2');
    expect(restored.kind).toBe('ui');
    expect(r.getVersion(db, s.id, 4).snapshotJson.restoredFrom).toBe(1);
  });

  it('rejects invalid steps with the step number', () => {
    const a = app();
    const m = r.createModule(db, a.id, { name: 'M' });
    const s = r.createScenario(db, m.id, { name: 'S' });
    expect(() => r.saveSteps(db, s.id, [{ type: 'ui.click' }, { type: 'ui.teleport' }])).toThrow(/Step 2/);
    expect(r.getScenario(db, s.id).version).toBe(1); // transaction rolled back
  });

  it('duplicates with steps, test cases and tags; moves; bulk deletes', () => {
    const a = app();
    const m1 = r.createModule(db, a.id, { name: 'Patients' });
    const m2 = r.createModule(db, a.id, { name: 'Billing' });
    const tag = r.createTag(db, a.id, { name: 'smoke' });
    const s = r.createScenario(db, m1.id, { name: 'Register', steps: [{ type: 'ui.click' }] });
    r.createTestCase(db, s.id, { title: 'Valid' });
    r.setScenarioTags(db, a.id, s.id, [tag.id]);
    const copy = r.duplicateScenario(db, s.id);
    expect(copy).toMatchObject({ name: 'Register (copy)', status: 'draft', tagIds: [tag.id] });
    expect(copy.steps).toHaveLength(1);
    expect(copy.steps[0]!.id).not.toBe(r.getScenario(db, s.id).steps[0]!.id);
    expect(copy.testCases).toHaveLength(1);

    r.moveScenarios(db, [s.id, copy.id], m2.id);
    expect(r.getScenario(db, s.id).moduleId).toBe(m2.id);
    r.deleteScenarios(db, [s.id, copy.id]);
    expect(db.select().from(schema.scenarios).all()).toHaveLength(0);
  });

  it('refuses cross-application moves and foreign tags', () => {
    const a = app();
    const b = r.createApplication(db, { name: 'Shop', slug: 'shop' });
    const ma = r.createModule(db, a.id, { name: 'A' });
    const mb = r.createModule(db, b.id, { name: 'B' });
    const s = r.createScenario(db, ma.id, { name: 'S' });
    expect(() => r.moveScenarios(db, [s.id], mb.id)).toThrow(/same application/);
    const foreign = r.createTag(db, b.id, { name: 'x' });
    expect(() => r.setScenarioTags(db, a.id, s.id, [foreign.id])).toThrow(/do not belong/);
  });
});

describe('test cases', () => {
  it('generates sequential module-based codes unique per application', () => {
    const a = app();
    const m = r.createModule(db, a.id, { name: 'Patients' });
    const s1 = r.createScenario(db, m.id, { name: 'S1' });
    const s2 = r.createScenario(db, m.id, { name: 'S2' });
    expect(r.createTestCase(db, s1.id, { title: 'a' }).code).toBe('TC-PAT-001');
    expect(r.createTestCase(db, s2.id, { title: 'b' }).code).toBe('TC-PAT-002');
    expect(r.createTestCase(db, s1.id, { title: 'c', code: 'TC-CUSTOM-9' }).code).toBe('TC-CUSTOM-9');
    const tc = r.createTestCase(db, s1.id, { title: 'd', data: { email: 'a@b.c' }, technique: 'negative' });
    expect(r.updateTestCase(db, tc.id, { data: { email: '' } }).dataJson).toEqual({ email: '' });
  });
});

describe('tree and search', () => {
  it('returns flat tree lists and finds entities', () => {
    const a = app();
    const m = r.createModule(db, a.id, { name: 'Patients' });
    const s = r.createScenario(db, m.id, {
      name: 'Register patient',
      steps: [{ type: 'ui.click' }, { type: 'ui.fill' }],
    });
    r.createTestCase(db, s.id, { title: 'Valid registration' });
    const tree = r.getTree(db, a.id);
    expect(tree.modules).toHaveLength(1);
    expect(tree.scenarios[0]).toMatchObject({ name: 'Register patient', stepCount: 2, tagIds: [] });
    expect(tree.testCases[0]?.code).toBe('TC-PAT-001');
    const hits = r.search(db, 'regist');
    expect(hits.map((h) => h.kind).sort()).toEqual(['scenario', 'testCase']);
    expect(r.search(db, 'care')[0]).toMatchObject({ kind: 'application', title: 'CareClinic' });
  });
});
