import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { ModuleTreeNode } from '@/lib/tree';

/**
 * A module's hooks: a block run before every test of the module and its sub-modules (a failure skips the test), and
 * one run after each (always, even after a failure — for cleanup).
 */
export function HooksDialog({
  applicationId,
  module,
  onClose,
}: {
  applicationId: string;
  module: ModuleTreeNode;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const blocks = useQuery({
    queryKey: ['blocks', applicationId],
    queryFn: () => api<{ id: string; name: string }[]>(`/api/applications/${applicationId}/blocks`),
  });
  const [before, setBefore] = useState(module.setupBlockId ?? '');
  const [after, setAfter] = useState(module.teardownBlockId ?? '');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/modules/${module.id}`, {
        method: 'PATCH',
        json: { setupBlockId: before || null, teardownBlockId: after || null },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tree(applicationId) });
      void qc.invalidateQueries({ queryKey: ['blocks', applicationId] });
      toast(
        `Hooks of ${module.name} saved — they apply to ${module.total} test${module.total === 1 ? '' : 's'}`,
      );
      onClose();
    },
    onError: toastError,
  });
  const options = (
    <>
      <option value="">None</option>
      {blocks.data?.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Hooks of ${module.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save hooks
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Blocks that run around every test in <b className="text-fg">{module.name}</b> and its sub-modules (
          {module.total} test{module.total === 1 ? '' : 's'}). Outer modules’ hooks run first before, and last
          after.
        </p>
        <Field label="Before each test" hint="e.g. sign in or reset data; a failure here skips the test">
          <Select aria-label="Before each test" value={before} onChange={(e) => setBefore(e.target.value)}>
            {options}
          </Select>
        </Field>
        <Field label="After each test" hint="e.g. sign out or clean up; runs even when the test failed">
          <Select aria-label="After each test" value={after} onChange={(e) => setAfter(e.target.value)}>
            {options}
          </Select>
        </Field>
        {!blocks.data?.length && (
          <p className="text-xs text-muted">
            Create blocks first (application → Blocks, or “Make a block” from steps).
          </p>
        )}
      </div>
    </Dialog>
  );
}
