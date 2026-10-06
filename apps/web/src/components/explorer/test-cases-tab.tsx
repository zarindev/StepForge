import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileCheck2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, PRIORITY_TONE, STATUS_TONE } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { ScenarioDetail, TestCase } from '@/lib/types';

const TECHNIQUES = ['positive', 'negative', 'boundary', 'equivalence', 'error-guessing', 'security', 'other'];
type Form = {
  code: string;
  title: string;
  technique: string;
  priority: string;
  status: string;
  data: string;
  expectedResult: string;
};

export function TestCasesTab({ scenario }: { scenario: ScenarioDetail }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TestCase | 'new' | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.scenario(scenario.id) });
    qc.invalidateQueries({ queryKey: qk.tree(scenario.applicationId) });
  };
  const save = useMutation({
    mutationFn: (f: Form) => {
      const body = {
        ...(f.code.trim() && { code: f.code.trim() }),
        title: f.title,
        technique: f.technique,
        priority: f.priority,
        status: f.status,
        data: JSON.parse(f.data || '{}'),
        expectedResult: f.expectedResult,
      };
      return editing === 'new' || !editing
        ? api(`/api/scenarios/${scenario.id}/test-cases`, { method: 'POST', json: body })
        : api(`/api/test-cases/${editing.id}`, { method: 'PATCH', json: body });
    },
    onSuccess: () => {
      refresh();
      toast(editing === 'new' ? 'Test case added' : 'Test case saved');
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/test-cases/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: toastError,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Each test case runs the scenario with its own data, available as {'{{data.<field>}}'}.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> Add test case
        </Button>
      </div>
      {scenario.testCases.length === 0 ? (
        <EmptyState
          icon={FileCheck2}
          title="No test cases"
          description="Add at least one test case: the data row and expected result this scenario is run with."
          action={<Button onClick={() => setEditing('new')}>Add test case</Button>}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-fg/[0.03] text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Technique</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {scenario.testCases.map((tc) => (
                <tr key={tc.id} className="hover:bg-fg/[0.02]">
                  <td className="px-3 py-2 font-mono text-xs">{tc.code}</td>
                  <td className="px-3 py-2">
                    <div>{tc.title}</div>
                    {tc.expectedResult && (
                      <div className="text-xs text-muted">Expected: {tc.expectedResult}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge>{tc.technique}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={PRIORITY_TONE[tc.priority]}>{tc.priority}</Badge>
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs text-muted">
                    {JSON.stringify(tc.dataJson)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[tc.status]}>{tc.status}</Badge>
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${tc.code}`}
                      onClick={() => setEditing(tc)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${tc.code}`}
                      onClick={() => remove.mutate(tc.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TestCaseDialog
          tc={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSubmit={(f) => save.mutate(f)}
          busy={save.isPending}
          error={save.error?.message}
        />
      )}
    </div>
  );
}

function TestCaseDialog({
  tc,
  onClose,
  onSubmit,
  busy,
  error,
}: {
  tc?: TestCase;
  onClose: () => void;
  onSubmit: (f: Form) => void;
  busy: boolean;
  error?: string;
}) {
  const [f, setF] = useState<Form>({
    code: tc?.code ?? '',
    title: tc?.title ?? '',
    technique: tc?.technique ?? 'positive',
    priority: tc?.priority ?? 'P2',
    status: tc?.status ?? 'active',
    data: JSON.stringify(tc?.dataJson ?? {}, null, 2),
    expectedResult: tc?.expectedResult ?? '',
  });
  const set = (p: Partial<Form>) => setF((c) => ({ ...c, ...p }));
  let dataError: string | undefined;
  try {
    const parsed = JSON.parse(f.data || '{}');
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null)
      dataError = 'Must be a JSON object';
  } catch {
    dataError = 'Invalid JSON';
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={tc ? `Edit ${tc.code}` : 'New test case'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.title.trim() || !!dataError || busy} onClick={() => onSubmit(f)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Code" hint={tc ? undefined : 'Leave empty to generate (TC-XXX-001)'}>
            <Input
              className="font-mono"
              value={f.code}
              onChange={(e) => set({ code: e.target.value })}
              placeholder="auto"
            />
          </Field>
          <Field label="Title" className="col-span-2">
            <Input
              autoFocus
              value={f.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Valid registration"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Technique">
            <Select value={f.technique} onChange={(e) => set({ technique: e.target.value })}>
              {TECHNIQUES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
              {['P1', 'P2', 'P3', 'P4'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="active">active</option>
              <option value="skipped">skipped</option>
            </Select>
          </Field>
        </div>
        <Field label="Data (JSON object)" hint="Available in steps as {{data.<field>}}" error={dataError}>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            spellCheck={false}
            value={f.data}
            onChange={(e) => set({ data: e.target.value })}
          />
        </Field>
        <Field label="Expected result">
          <Textarea
            rows={2}
            value={f.expectedResult}
            onChange={(e) => set({ expectedResult: e.target.value })}
          />
        </Field>
        {error && <p className="text-sm text-fail">{error}</p>}
      </div>
    </Dialog>
  );
}
