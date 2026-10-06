import { ArrowDown, ArrowUp, ChevronRight, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { defaultParams, groupOf, LAYER, STEP_TYPE_OPTIONS, summarizeStep } from '@/lib/steps';
import { cn } from '@/lib/utils';
import { blankStep, newKey, toDrafts, fromDrafts, type DraftStep } from './drafts';
import { StepForm } from './step-form';

export function StepTypeSelect({
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

/** Controlled, recursive step list (top level and nested control-flow branches). */
export function StepList({
  steps,
  onChange,
  depth = 0,
  openKey,
  onOpen,
  ariaLabel = 'Steps',
}: {
  steps: DraftStep[];
  onChange: (s: DraftStep[]) => void;
  depth?: number;
  openKey?: string | null;
  onOpen?: (k: string | null) => void;
  ariaLabel?: string;
}) {
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const open = onOpen ? (openKey ?? null) : localOpen;
  const setOpen = onOpen ?? setLocalOpen;
  const [newType, setNewType] = useState(depth ? 'util.log' : 'ui.click');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const add = () => {
    const d = blankStep(newType, defaultParams(newType));
    onChange([...steps, d]);
    setOpen(d._k);
  };

  return (
    <div className="space-y-1.5">
      <ol className="space-y-1.5" aria-label={ariaLabel}>
        {steps.map((s, i) => {
          const L = LAYER[groupOf(s.type)];
          const expanded = open === s._k;
          const nested = [
            ...(Array.isArray(s.params.steps) ? s.params.steps : []),
            ...(Array.isArray(s.params.else) ? s.params.else : []),
          ].length;
          return (
            <li
              key={s._k}
              onDragOver={(e) => dragIndex !== null && e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation();
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
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : s._k)}
                >
                  <span className="truncate text-sm">{summarizeStep(s)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{s.type}</span>
                  {nested > 0 && <Badge>{nested} nested</Badge>}
                  {s.captureAs && <Badge tone="indigo">→ vars.{s.captureAs}</Badge>}
                  {s.locators.length > 1 && (
                    <Badge title="Fallback locators for self-healing">
                      +{s.locators.length - 1} fallback
                    </Badge>
                  )}
                  {s.type === 'util.wait' && <Badge tone="warn">hard wait</Badge>}
                  <ChevronRight
                    className={cn(
                      'ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                </button>
                <div className="flex items-center">
                  <IconBtn label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0} icon={ArrowUp} />
                  <IconBtn
                    label="Move down"
                    onClick={() => move(i, i + 1)}
                    disabled={i === steps.length - 1}
                    icon={ArrowDown}
                  />
                  <IconBtn
                    label="Duplicate step"
                    icon={Copy}
                    onClick={() => {
                      const { id: _id, ...rest } = fromDrafts([s])[0]!;
                      onChange([
                        ...steps.slice(0, i + 1),
                        { ...toDrafts([rest])[0]!, _k: newKey() },
                        ...steps.slice(i + 1),
                      ]);
                    }}
                  />
                  <IconBtn
                    label="Delete step"
                    icon={Trash2}
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  />
                </div>
              </div>
              {expanded && (
                <StepForm
                  step={s}
                  depth={depth}
                  onChange={(next) => onChange(steps.map((x, j) => (j === i ? next : x)))}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2">
        <StepTypeSelect
          aria-label={depth ? 'Nested step type' : 'New step type'}
          className="h-8 w-52 text-xs"
          value={newType}
          onChange={setNewType}
        />
        <Button variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> {depth ? 'Add nested step' : 'Add step'}
        </Button>
      </div>
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
