import { useState } from 'react';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';

/** Confirmation dialog; when `typeToConfirm` is set the user must type that exact text (Section 12). */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  typeToConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (typed: string) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  typeToConfirm?: string;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ready = !typeToConfirm || typed === typeToConfirm;
  const close = () => {
    setTyped('');
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready || busy} onClick={() => onConfirm(typed)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{description}</p>
      {typeToConfirm && (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs text-muted">
            Type <span className="font-mono font-semibold text-fg">{typeToConfirm}</span> to confirm
          </p>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Confirmation text"
          />
        </div>
      )}
    </Dialog>
  );
}
