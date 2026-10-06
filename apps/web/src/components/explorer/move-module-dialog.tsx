import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { flattenModules, type ModuleTreeNode } from '@/lib/tree';
import type { Tree } from '@/lib/types';

/** Re-parents a module without drag and drop. Its own sub-modules are not valid targets. */
export function MoveModuleDialog({
  module,
  tree,
  onMove,
  onClose,
  busy,
}: {
  module: ModuleTreeNode;
  tree: Tree;
  onMove: (parentId: string | null) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const blocked = new Set<string>([module.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of tree.modules) {
      if (m.parentId && blocked.has(m.parentId) && !blocked.has(m.id)) {
        blocked.add(m.id);
        grew = true;
      }
    }
  }
  const options = flattenModules(tree).filter((m) => !blocked.has(m.id));
  const [target, setTarget] = useState<string>(module.parentId ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Move "${module.name}"`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || target === (module.parentId ?? '')}
            onClick={() => onMove(target || null)}
          >
            Move
          </Button>
        </>
      }
    >
      <Field label="New parent">
        <Select aria-label="New parent" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Top level</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}
