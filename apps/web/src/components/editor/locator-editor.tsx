import type { Locator } from '@stepforge/core';
import { ArrowDown, ArrowUp, Plus, Star, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';

const STRATEGIES: Locator['strategy'][] = ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'];
const HINT: Record<string, string> = {
  testId: 'data-testid value',
  role: 'ARIA role, e.g. button',
  label: 'Label text',
  placeholder: 'Placeholder text',
  text: 'Visible text',
  css: 'CSS selector',
  xpath: 'XPath',
};

/** Ranked locator list: the first is used; the others are self-healing fallbacks. */
export function LocatorEditor({ value, onChange }: { value: Locator[]; onChange: (v: Locator[]) => void }) {
  const update = (i: number, patch: Partial<Locator>) =>
    onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(to, 0, x!);
    onChange(next);
  };
  return (
    <div className="space-y-1.5" role="group" aria-label="Locators">
      {value.map((l, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {i === 0 ? (
            <Badge tone="brand" title="Used first">
              <Star className="h-3 w-3" /> primary
            </Badge>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              title="Make primary"
              onClick={() => move(i, 0)}
            >
              use first
            </Button>
          )}
          <Select
            aria-label={`Locator ${i + 1} strategy`}
            className="h-8 w-32 text-xs"
            value={l.strategy}
            onChange={(e) => update(i, { strategy: e.target.value as Locator['strategy'] })}
          >
            {STRATEGIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Input
            aria-label={`Locator ${i + 1} value`}
            className="h-8 flex-1 font-mono text-xs"
            placeholder={HINT[l.strategy]}
            value={l.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          {l.strategy === 'role' && (
            <Input
              aria-label={`Locator ${i + 1} name`}
              className="h-8 w-44 text-xs"
              placeholder="Accessible name"
              value={l.name ?? ''}
              onChange={(e) => update(i, { name: e.target.value || undefined })}
            />
          )}
          <button
            aria-label="Move locator up"
            className="rounded p-1 text-muted hover:text-fg disabled:opacity-30"
            disabled={i === 0}
            onClick={() => move(i, i - 1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Move locator down"
            className="rounded p-1 text-muted hover:text-fg disabled:opacity-30"
            disabled={i === value.length - 1}
            onClick={() => move(i, i + 1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Remove locator"
            className="rounded p-1 text-muted hover:text-fail"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...value, { strategy: value.length ? 'css' : 'testId', value: '' }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add locator
      </Button>
    </div>
  );
}
