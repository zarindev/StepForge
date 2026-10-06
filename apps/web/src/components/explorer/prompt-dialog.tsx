import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';

/** Single text input dialog used for naming modules and scenarios. */
export function PromptDialog({
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel = 'Create',
  onSubmit,
  onClose,
  busy,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => value.trim() && onSubmit(value.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!value.trim() || busy} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={label}>
          <Input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
