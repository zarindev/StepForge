import { STEP_CATALOGUE, type StepGroup } from '@stepforge/core';
import { Database, Gauge, Mail, MonitorSmartphone, Webhook, Wrench, type LucideIcon } from 'lucide-react';
import type { StepRecord } from './types';

/** Layer colours from Section 7.3: UI blue, API indigo, DB green, Email amber, Perf pink, Util grey. */
export const LAYER: Record<StepGroup, { label: string; icon: LucideIcon; color: string }> = {
  ui: { label: 'UI', icon: MonitorSmartphone, color: '#3B82F6' },
  api: { label: 'API', icon: Webhook, color: '#6366F1' },
  db: { label: 'Database', icon: Database, color: '#22C55E' },
  email: { label: 'Email', icon: Mail, color: '#F59E0B' },
  perf: { label: 'Performance', icon: Gauge, color: '#EC4899' },
  util: { label: 'Utility', icon: Wrench, color: '#94A3B8' },
};

export const KIND_LAYER: Record<string, StepGroup | 'hybrid'> = {
  ui: 'ui',
  api: 'api',
  db: 'db',
  email: 'email',
  perf: 'perf',
  hybrid: 'hybrid',
};

export function groupOf(type: string): StepGroup {
  return (type.split('.')[0] as StepGroup) in LAYER ? (type.split('.')[0] as StepGroup) : 'util';
}

export const STEP_TYPE_OPTIONS = (Object.keys(STEP_CATALOGUE) as StepGroup[]).map((g) => ({
  group: g,
  label: LAYER[g].label,
  types: STEP_CATALOGUE[g].map((n) => `${g}.${n}`),
}));

/** Sensible starter params so a new step is self-explanatory. */
export function defaultParams(type: string): Record<string, unknown> {
  switch (type) {
    case 'ui.navigate':
      return { url: '{{env.baseUrl}}/' };
    case 'ui.fill':
    case 'ui.type':
      return { value: '' };
    case 'ui.press':
      return { key: 'Enter' };
    case 'api.request':
      return { method: 'GET', url: '{{env.baseUrl}}/api/', headers: {} };
    case 'db.query':
      return { connection: '', sql: 'SELECT 1' };
    case 'db.mongoFind':
      return { connection: '', collection: '', filter: {} };
    case 'db.runScript':
      return { connection: '', script: '' };
    case 'db.extract':
      return { path: 'value' };
    case 'db.dataQualityCheck':
      return { connection: '', maxIssues: 0 };
    case 'email.waitForEmail':
      return { to: '', subject: '', timeoutMs: 30000 };
    case 'util.setVariable':
      return { name: '', value: '' };
    case 'util.wait':
      return { ms: 1000 };
    case 'util.log':
      return { message: '' };
    default:
      return {};
  }
}

/** One-line human summary of a step for collapsed rows. */
export function summarizeStep(s: StepRecord): string {
  if (s.label) return s.label;
  const p = s.params as Record<string, unknown>;
  const target = s.locators[0] ? ` → ${s.locators[0].name ?? s.locators[0].value}` : '';
  const main =
    p.url ??
    p.sql ??
    p.script ??
    p.collection ??
    p.procedure ??
    p.value ??
    p.key ??
    p.message ??
    p.subject ??
    p.name ??
    '';
  return `${s.type.split('.')[1]}${main ? ` ${String(main)}` : ''}${target}`;
}
