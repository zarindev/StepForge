import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useTree } from '@/lib/queries';
import { flattenModules } from '@/lib/tree';
import type { ScenarioDetail } from '@/lib/types';

export type DraftAssertion = { target: string; operator: string; expected: string };

const DB_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
  'noNulls',
  'unique',
  'inRange',
];
const NO_EXPECTED = new Set(['exists', 'notExists', 'isEmpty', 'isNotEmpty', 'noNulls', 'unique']);

/** Expected values are typed as text; numbers, booleans, null and JSON are converted. */
function parseExpected(v: string): unknown {
  const t = v.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* keep as text */
    }
  }
  return v;
}

/** Turns a workbench query (or audit finding) into a scenario with a db.query step and assertions. */
export function SaveDbTestDialog({
  applicationId,
  connectionName,
  sql,
  columns,
  initialAssertions,
  defaultName,
  audit,
  onClose,
}: {
  applicationId: string;
  connectionName: string;
  sql: string;
  /** Save a data-quality check step instead of a query. */
  audit?: { tables: string[]; checks: string[] };
  columns: string[];
  initialAssertions: DraftAssertion[];
  defaultName: string;
  onClose: () => void;
}) {
  const tree = useTree(applicationId);
  const modules = tree.data ? flattenModules(tree.data) : [];
  const [moduleId, setModuleId] = useState('');
  const [name, setName] = useState(defaultName);
  const [assertions, setAssertions] = useState<DraftAssertion[]>(initialAssertions);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const target = moduleId || modules[0]?.id || '';
  const setRow = (i: number, p: Partial<DraftAssertion>) =>
    setAssertions((a) => a.map((x, j) => (i === j ? { ...x, ...p } : x)));

  const save = useMutation({
    mutationFn: () =>
      api<ScenarioDetail>(`/api/modules/${target}/scenarios`, {
        method: 'POST',
        json: {
          name,
          steps: [
            audit
              ? { type: 'db.dataQualityCheck', params: { connection: connectionName, ...audit } }
              : {
                  type: 'db.query',
                  params: { connection: connectionName, sql },
                  assertions: assertions
                    .filter((a) => a.target.trim())
                    .map((a) => ({
                      target: a.target.trim(),
                      operator: a.operator,
                      ...(!NO_EXPECTED.has(a.operator) && { expected: parseExpected(a.expected) }),
                    })),
                },
          ],
        },
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.tree(applicationId) });
      toast(audit ? 'Saved as a data-quality test' : 'Saved as a DB test');
      onClose();
      navigate({ to: '/explorer', search: { scenario: s.id } });
    },
    onError: toastError,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Save as DB test"
      description={`Creates a scenario with a db.query step on the “${connectionName}” connection. In a run, the environment's connection with this name is used.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!target || !name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input aria-label="Test name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Module">
            <Select
              aria-label="Save into module"
              value={target}
              onChange={(e) => setModuleId(e.target.value)}
            >
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {modules.length === 0 && (
          <p className="text-sm text-fail">Create a module in the Test Explorer first.</p>
        )}
        {audit ? (
          <p className="text-sm text-muted">
            Adds a <code>db.dataQualityCheck</code> step running {audit.checks.join(', ')} on{' '}
            {audit.tables.length} table{audit.tables.length === 1 ? '' : 's'}. It fails when any issue is
            found.
          </p>
        ) : (
          <>
            <pre className="max-h-32 overflow-auto rounded-lg bg-fg/[0.04] p-2 font-mono text-xs whitespace-pre-wrap">
              {sql}
            </pre>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">Assertions</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setAssertions((a) => [...a, { target: 'rowCount', operator: 'equals', expected: '' }])
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Add assertion
                </Button>
              </div>
              <datalist id="db-targets">
                {[
                  'rowCount',
                  'value',
                  'affected',
                  'rows',
                  ...columns,
                  ...columns.map((c) => `column:${c}`),
                  ...columns.map((c) => `rows[0].${c}`),
                ].map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {assertions.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Assertion ${i + 1} target`}
                    list="db-targets"
                    className="font-mono text-xs"
                    value={a.target}
                    onChange={(e) => setRow(i, { target: e.target.value })}
                  />
                  <Select
                    aria-label={`Assertion ${i + 1} operator`}
                    className="w-36 shrink-0"
                    value={a.operator}
                    onChange={(e) => setRow(i, { operator: e.target.value })}
                  >
                    {DB_OPERATORS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                  <Input
                    aria-label={`Assertion ${i + 1} expected`}
                    className="font-mono text-xs"
                    disabled={NO_EXPECTED.has(a.operator)}
                    placeholder={a.operator === 'inRange' ? '0..100' : 'expected'}
                    value={NO_EXPECTED.has(a.operator) ? '' : a.expected}
                    onChange={(e) => setRow(i, { expected: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove assertion ${i + 1}`}
                    onClick={() => setAssertions((x) => x.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted">
                Targets: <code>rowCount</code>, <code>value</code> (first cell, e.g. COUNT(*)), a column name
                (first row), <code>column:name</code> (all values), <code>rows[0].name</code>. Expected values
                may use <code>{'{{vars.x}}'}</code> or <code>{'{{data.x}}'}</code>.
              </p>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
