import { generateVariants, type Variant } from '@stepforge/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { ScenarioDetail } from '@/lib/types';

const TONE: Record<Variant['technique'], 'fail' | 'warn' | 'indigo' | 'neutral'> = {
  negative: 'fail',
  boundary: 'warn',
  security: 'indigo',
  equivalence: 'neutral',
};

/** Rule-based negative/boundary/security variants of an existing test case (no AI). */
export function VariantsDialog({ scenario, onClose }: { scenario: ScenarioDetail; onClose: () => void }) {
  const withData = scenario.testCases.filter((t) => Object.keys(t.dataJson).length > 0);
  const [baseId, setBaseId] = useState(withData[0]?.id ?? '');
  const base = withData.find((t) => t.id === baseId);
  const keys = Object.keys(base?.dataJson ?? {});
  const [fields, setFields] = useState<Set<string>>(() => new Set(keys));
  const variants = useMemo(
    () =>
      base
        ? generateVariants(
            base.dataJson,
            keys.filter((k) => fields.has(k)),
          )
        : [],
    [base, keys, fields],
  );
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const chosen = variants.filter((_, i) => !skip.has(i));
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: async () => {
      for (const v of chosen) {
        await api(`/api/scenarios/${scenario.id}/test-cases`, {
          method: 'POST',
          json: {
            title: `${base!.title} — ${v.title}`,
            data: v.data,
            technique: v.technique,
            expectedResult: v.expectedResult,
            priority: 'P3',
          },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.scenario(scenario.id) });
      qc.invalidateQueries({ queryKey: qk.tree(scenario.applicationId) });
      toast(`Created ${chosen.length} test case(s)`);
      onClose();
    },
    onError: toastError,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Generate variants"
      description="Negative, boundary and security data derived by rules from an existing test case."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!chosen.length || create.isPending} onClick={() => create.mutate()}>
            <Wand2 className="h-4 w-4" /> Create {chosen.length} test case(s)
          </Button>
        </>
      }
    >
      {withData.length === 0 ? (
        <p className="text-sm text-muted">
          Add a test case with data (for example {'{ "email": "a@b.test" }'}) first.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Base test case">
            <Select
              aria-label="Base test case"
              value={baseId}
              onChange={(e) => {
                setBaseId(e.target.value);
                setFields(
                  new Set(Object.keys(withData.find((t) => t.id === e.target.value)?.dataJson ?? {})),
                );
                setSkip(new Set());
              }}
            >
              {withData.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.title}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Fields to vary</p>
            <div className="flex flex-wrap gap-3">
              {keys.map((k) => (
                <label key={k} className="flex items-center gap-1.5 font-mono text-sm">
                  <input
                    type="checkbox"
                    className="accent-[#F97316]"
                    checked={fields.has(k)}
                    onChange={() => {
                      setSkip(new Set());
                      setFields((f) => {
                        const n = new Set(f);
                        if (n.has(k)) n.delete(k);
                        else n.add(k);
                        return n;
                      });
                    }}
                  />
                  {k}
                </label>
              ))}
            </div>
          </div>
          <ul
            className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border"
            aria-label="Variants"
          >
            {variants.map((v, i) => (
              <li key={`${v.title}-${i}`} className="flex items-start gap-2 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Include ${v.title}`}
                  className="mt-1 accent-[#F97316]"
                  checked={!skip.has(i)}
                  onChange={() =>
                    setSkip((s) => {
                      const n = new Set(s);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span>{v.title}</span>
                    <Badge tone={TONE[v.technique]}>{v.technique}</Badge>
                  </div>
                  <div className="truncate font-mono text-xs text-muted">
                    {JSON.stringify(v.data[v.field])}
                  </div>
                  <div className="text-xs text-muted">Expected: {v.expectedResult}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
