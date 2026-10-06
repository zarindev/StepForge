import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  GripVertical,
  ListPlus,
  Plus,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { defaultParams, groupOf, LAYER, STEP_TYPE_OPTIONS, summarizeStep } from '@/lib/steps';
import type { ScenarioDetail, StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type Draft = StepRecord & {
  _key: string;
  _json?: Partial<Record<'params' | 'locators' | 'assertions', string>>;
};
let keySeq = 0;
const toDraft = (s: StepRecord): Draft => ({ ...s, _key: s.id ?? `new-${++keySeq}` });
const clean = (d: Draft): StepRecord => {
  const { _key: _k, _json: _j, ...s } = d;
  return s;
};

function StepTypeSelect({
  value,
  onChange,
  ...p
}: {
  value: string;
  onChange: (v: string) => void;
  'aria-label': string;
  className?: string;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} {...p}>
      {STEP_TYPE_OPTIONS.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {g.types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Ordered step list editor. Saving replaces the scenario's steps and creates a new version. */
export function StepsEditor({ scenario }: { scenario: ScenarioDetail }) {
  const original = useMemo(() => scenario.steps.map(toDraft), [scenario.steps]);
  const [steps, setSteps] = useState<Draft[]>(original);
  const [open, setOpen] = useState<string | null>(null);
  const [newType, setNewType] = useState('ui.click');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const qc = useQueryClient();

  const dirty = JSON.stringify(steps.map(clean)) !== JSON.stringify(original.map(clean));
  const jsonErrors = steps.some(
    (s) => s._json && Object.values(s._json).some((v) => v !== undefined && !isJson(v)),
  );

  const save = useMutation({
    mutationFn: () =>
      api<ScenarioDetail>(`/api/scenarios/${scenario.id}/steps`, {
        method: 'PUT',
        json: { steps: steps.map(clean) },
      }),
    onSuccess: (s) => {
      qc.setQueryData(qk.scenario(s.id), s);
      qc.invalidateQueries({ queryKey: qk.tree(s.applicationId) });
      qc.invalidateQueries({ queryKey: qk.versions(s.id) });
      toast(`Saved steps · v${s.version}`);
    },
    onError: toastError,
  });

  const update = (i: number, patch: Partial<Draft>) =>
    setSteps((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (from: number, to: number) =>
    setSteps((cur) => {
      if (to < 0 || to >= cur.length) return cur;
      const next = [...cur];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  const add = () => {
    const d = toDraft({
      type: newType,
      params: defaultParams(newType),
      locators: [],
      assertions: [],
      enabled: true,
      continueOnFail: false,
      retries: 0,
    });
    setSteps((cur) => [...cur, d]);
    setOpen(d._key);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StepTypeSelect aria-label="New step type" className="w-56" value={newType} onChange={setNewType} />
        <Button variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add step
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-warn">Unsaved changes</span>}
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setSteps(original)}>
            <Undo2 className="h-3.5 w-3.5" /> Discard
          </Button>
          <Button size="sm" disabled={!dirty || jsonErrors || save.isPending} onClick={() => save.mutate()}>
            <Save className="h-3.5 w-3.5" /> Save steps
          </Button>
        </div>
      </div>

      {steps.length === 0 ? (
        <EmptyState
          icon={ListPlus}
          title="No steps yet"
          description="Add UI, API, database, email, performance or utility steps. In Phase 4 the recorder will capture them for you."
        />
      ) : (
        <ol className="space-y-1.5" aria-label="Steps">
          {steps.map((s, i) => {
            const L = LAYER[groupOf(s.type)];
            const expanded = open === s._key;
            return (
              <li
                key={s._key}
                onDragOver={(e) => dragIndex !== null && e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) move(dragIndex, i);
                  setDragIndex(null);
                }}
                className={cn(
                  'rounded-lg border border-border bg-surface',
                  !s.enabled && 'opacity-55',
                  dragIndex === i && 'opacity-40',
                )}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    onDragEnd={() => setDragIndex(null)}
                    className="cursor-grab text-muted"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                  <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
                  <span
                    className="grid h-6 w-6 place-items-center rounded-md"
                    style={{ background: `${L.color}22`, color: L.color }}
                  >
                    <L.icon className="h-3.5 w-3.5" />
                  </span>
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen(expanded ? null : s._key)}
                  >
                    <span className="truncate text-sm">{summarizeStep(s)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted">{s.type}</span>
                    {s.captureAs && <Badge tone="indigo">→ vars.{s.captureAs}</Badge>}
                    {s.type === 'util.wait' && <Badge tone="warn">hard wait</Badge>}
                    <ChevronRight
                      className={cn(
                        'ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform',
                        expanded && 'rotate-90',
                      )}
                    />
                  </button>
                  <div className="flex items-center">
                    <IconBtn
                      label="Move up"
                      onClick={() => move(i, i - 1)}
                      disabled={i === 0}
                      icon={ArrowUp}
                    />
                    <IconBtn
                      label="Move down"
                      onClick={() => move(i, i + 1)}
                      disabled={i === steps.length - 1}
                      icon={ArrowDown}
                    />
                    <IconBtn
                      label="Duplicate step"
                      icon={Copy}
                      onClick={() =>
                        setSteps((cur) => [
                          ...cur.slice(0, i + 1),
                          toDraft({ ...clean(s), id: undefined }),
                          ...cur.slice(i + 1),
                        ])
                      }
                    />
                    <IconBtn
                      label="Delete step"
                      icon={Trash2}
                      onClick={() => setSteps((cur) => cur.filter((_, j) => j !== i))}
                    />
                  </div>
                </div>
                {expanded && <StepForm step={s} onChange={(p) => update(i, p)} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function IconBtn({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof Copy;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1.5 text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-30"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function isJson(v: string): boolean {
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

function JsonField({
  label,
  hint,
  value,
  draft,
  onDraft,
  onValid,
}: {
  label: string;
  hint?: string;
  value: unknown;
  draft: string | undefined;
  onDraft: (v: string) => void;
  onValid: (v: unknown) => void;
}) {
  const text = draft ?? JSON.stringify(value, null, 2);
  const bad = draft !== undefined && !isJson(draft);
  return (
    <Field label={label} hint={hint} error={bad ? 'Invalid JSON' : undefined}>
      <Textarea
        spellCheck={false}
        className={cn('font-mono text-xs', bad && 'border-fail/60')}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          onDraft(e.target.value);
          if (isJson(e.target.value)) onValid(JSON.parse(e.target.value));
        }}
      />
    </Field>
  );
}

function StepForm({ step, onChange }: { step: Draft; onChange: (p: Partial<Draft>) => void }) {
  const setJson = (k: 'params' | 'locators' | 'assertions', v: string) =>
    onChange({ _json: { ...step._json, [k]: v } });
  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Type">
          <StepTypeSelect
            aria-label="Step type"
            value={step.type}
            onChange={(type) =>
              onChange({
                type,
                params: Object.keys(step.params).length ? step.params : defaultParams(type),
                _json: undefined,
              })
            }
          />
        </Field>
        <Field label="Label" className="md:col-span-2" hint="Shown in reports and the plain-English view">
          <Input
            value={step.label ?? ''}
            onChange={(e) => onChange({ label: e.target.value || undefined })}
          />
        </Field>
      </div>
      <JsonField
        label="Parameters"
        hint="Use {{env.*}}, {{secret.*}}, {{data.*}}, {{vars.*}}, {{random.*}}"
        value={step.params}
        draft={step._json?.params}
        onDraft={(v) => setJson('params', v)}
        onValid={(v) => onChange({ params: v as Record<string, unknown> })}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <JsonField
          label="Locators"
          hint='Ranked, e.g. [{"strategy":"testId","value":"save"}]'
          value={step.locators}
          draft={step._json?.locators}
          onDraft={(v) => setJson('locators', v)}
          onValid={(v) => Array.isArray(v) && onChange({ locators: v })}
        />
        <JsonField
          label="Assertions"
          hint='e.g. [{"target":"status","operator":"equals","expected":200}]'
          value={step.assertions}
          draft={step._json?.assertions}
          onDraft={(v) => setJson('assertions', v)}
          onValid={(v) => Array.isArray(v) && onChange({ assertions: v })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Capture output as" className="w-44">
          <Input
            value={step.captureAs ?? ''}
            placeholder="otp"
            className="font-mono"
            onChange={(e) => onChange({ captureAs: e.target.value || undefined })}
          />
        </Field>
        <Field label="Timeout (ms)" className="w-32">
          <Input
            type="number"
            min={1}
            value={step.timeoutMs ?? ''}
            placeholder="default"
            onChange={(e) => onChange({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Field>
        <Field label="Retries" className="w-24">
          <Input
            type="number"
            min={0}
            max={10}
            value={step.retries}
            onChange={(e) => onChange({ retries: Number(e.target.value) || 0 })}
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={step.enabled} onChange={(enabled) => onChange({ enabled })} label="Enabled" />{' '}
          Enabled
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch
            checked={step.continueOnFail}
            onChange={(continueOnFail) => onChange({ continueOnFail })}
            label="Continue on failure"
          />
          Continue on failure
        </label>
      </div>
    </div>
  );
}
