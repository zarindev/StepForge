import type { Assertion, Locator } from '@stepforge/core';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { defaultParams } from '@/lib/steps';
import { cn } from '@/lib/utils';
import { CodeEditor } from './code-editor';
import { useEditorCtx } from './context';
import type { DraftStep } from './drafts';
import { LocatorEditor } from './locator-editor';
import { getPath, NEEDS_LOCATOR, setPath, STEP_FIELDS, type FieldSpec } from './step-fields';
import { StepList, StepTypeSelect } from './step-list';

function JsonEditor({
  label,
  value,
  onValid,
  height = 120,
}: {
  label: string;
  value: unknown;
  onValid: (v: unknown) => void;
  height?: number;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted">
        {label}
        {bad && <span className="ml-2 text-fail">Invalid JSON</span>}
      </span>
      <CodeEditor
        ariaLabel={label}
        language="json"
        height={height}
        value={text}
        onChange={(t) => {
          setText(t);
          try {
            onValid(t.trim() ? JSON.parse(t) : undefined);
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
    </div>
  );
}

function TypedField({
  spec,
  params,
  onParams,
}: {
  spec: FieldSpec;
  params: Record<string, unknown>;
  onParams: (p: Record<string, unknown>) => void;
}) {
  const { scenarios, blocks } = useEditorCtx();
  const value = getPath(params, spec.key);
  const set = (v: unknown) => onParams(setPath(params, spec.key, v));
  const cls = spec.wide ? 'md:col-span-3' : '';
  switch (spec.kind) {
    case 'checkbox':
      return (
        <label className={cn('flex items-center gap-2 self-end pb-2 text-sm', cls)}>
          <Switch checked={!!value} onChange={(v) => set(v || undefined)} label={spec.label} /> {spec.label}
        </label>
      );
    case 'select':
      return (
        <Field label={spec.label} className={cls} hint={spec.hint}>
          <Select
            aria-label={spec.label}
            value={String(value ?? '')}
            onChange={(e) => set(e.target.value || undefined)}
          >
            <option value="">—</option>
            {spec.options!.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </Field>
      );
    case 'scenario':
    case 'block': {
      const opts = spec.kind === 'scenario' ? scenarios : blocks;
      return (
        <Field
          label={spec.label}
          className={cls}
          hint={
            opts.length
              ? undefined
              : spec.kind === 'block'
                ? 'Create blocks on the application’s Blocks tab'
                : 'No other scenarios'
          }
        >
          <Select
            aria-label={spec.label}
            value={String(value ?? '')}
            onChange={(e) => set(e.target.value || undefined)}
          >
            <option value="">Choose…</option>
            {opts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case 'code':
      if (spec.language === 'json') {
        return (
          <div className={cls}>
            <JsonEditor label={spec.label} value={value} onValid={set} />
          </div>
        );
      }
      return (
        <div className={cn('space-y-1.5', cls)}>
          <span className="text-xs font-medium text-muted">{spec.label}</span>
          <CodeEditor
            ariaLabel={spec.label}
            language={spec.language ?? 'plaintext'}
            value={String(value ?? '')}
            onChange={(v) => set(v)}
            height={spec.language === 'javascript' ? 160 : 120}
          />
        </div>
      );
    case 'number':
      return (
        <Field label={spec.label} className={cls} hint={spec.hint}>
          <Input
            aria-label={spec.label}
            type="number"
            value={value === undefined ? '' : String(value)}
            onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </Field>
      );
    default:
      return (
        <Field label={spec.label} className={cls} hint={spec.hint}>
          <Input
            aria-label={spec.label}
            placeholder={spec.placeholder}
            value={Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value)}
            onChange={(e) =>
              set(
                spec.key === 'files'
                  ? e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : e.target.value,
              )
            }
          />
        </Field>
      );
  }
}

/** Typed editor for one step (fields per type, locators, nested branches, advanced JSON). */
export function StepForm({
  step,
  onChange,
  depth,
}: {
  step: DraftStep;
  onChange: (s: DraftStep) => void;
  depth: number;
}) {
  const [advanced, setAdvanced] = useState(false);
  const specs = STEP_FIELDS[step.type];
  const set = (patch: Partial<DraftStep>) => onChange({ ...step, ...patch });
  const params = step.params;
  const nestedOf = (key: 'steps' | 'else') =>
    Array.isArray(params[key]) ? (params[key] as DraftStep[]) : [];

  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Type">
          <StepTypeSelect
            aria-label="Step type"
            value={step.type}
            onChange={(type) =>
              set({ type, params: Object.keys(params).length ? params : defaultParams(type) })
            }
          />
        </Field>
        <Field
          label="Label"
          className="md:col-span-2"
          hint="Optional: shown in reports and the plain-English view"
        >
          <Input value={step.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} />
        </Field>
      </div>

      {specs ? (
        <div className="grid gap-3 md:grid-cols-3">
          {specs.map((spec) => (
            <TypedField key={spec.key} spec={spec} params={params} onParams={(p) => set({ params: p })} />
          ))}
        </div>
      ) : (
        <JsonEditor
          label="Parameters (JSON)"
          value={params}
          onValid={(v) => set({ params: (v as Record<string, unknown>) ?? {} })}
        />
      )}

      {NEEDS_LOCATOR.has(step.type) && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">
            Element (ranked locators — the first one is used, the rest heal it)
          </span>
          <LocatorEditor value={step.locators} onChange={(locators: Locator[]) => set({ locators })} />
        </div>
      )}

      {(step.type === 'util.if' || step.type === 'util.loop') && (
        <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <p className="text-xs font-medium text-muted">
            {step.type === 'util.if' ? 'Then' : 'Repeat these steps'}
          </p>
          <StepList
            depth={depth + 1}
            ariaLabel="Nested steps"
            steps={nestedOf('steps')}
            onChange={(s) => set({ params: { ...params, steps: s } })}
          />
          {step.type === 'util.if' && (
            <>
              <p className="text-xs font-medium text-muted">Else</p>
              <StepList
                depth={depth + 1}
                ariaLabel="Else steps"
                steps={nestedOf('else')}
                onChange={(s) => set({ params: { ...params, else: s } })}
              />
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Capture output as" className="w-44">
          <Input
            value={step.captureAs ?? ''}
            placeholder="otp"
            className="font-mono"
            onChange={(e) => set({ captureAs: e.target.value || undefined })}
          />
        </Field>
        <Field label="Timeout (ms)" className="w-32">
          <Input
            type="number"
            min={1}
            value={step.timeoutMs ?? ''}
            placeholder="default"
            onChange={(e) => set({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Field>
        <Field label="Retries" className="w-24">
          <Input
            type="number"
            min={0}
            max={10}
            value={step.retries}
            onChange={(e) => set({ retries: Number(e.target.value) || 0 })}
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={step.enabled} onChange={(enabled) => set({ enabled })} label="Enabled" /> Enabled
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch
            checked={step.continueOnFail}
            onChange={(continueOnFail) => set({ continueOnFail })}
            label="Continue on failure"
          />{' '}
          Continue on failure
        </label>
      </div>

      <button
        className="flex items-center gap-1 text-xs text-muted hover:text-fg"
        onClick={() => setAdvanced((a) => !a)}
        aria-expanded={advanced}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', advanced && 'rotate-90')} /> Assertions
        and raw parameters (JSON)
      </button>
      {advanced && (
        <div className="grid gap-3 md:grid-cols-2">
          <JsonEditor
            label="Assertions"
            value={step.assertions}
            onValid={(v) => Array.isArray(v) && set({ assertions: v as Assertion[] })}
          />
          <JsonEditor
            label="Raw parameters"
            value={params}
            onValid={(v) => v && typeof v === 'object' && set({ params: v as Record<string, unknown> })}
          />
        </div>
      )}
    </div>
  );
}
