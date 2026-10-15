import type { Locator } from '@stepforge/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookmarkPlus, Crosshair, Unlink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useEditorCtx, type ElementOption } from './context';
import { LocatorEditor } from './locator-editor';

const describe = (l: Locator) =>
  l.strategy === 'image' ? 'image (a picture)' : `${l.strategy}=${l.value}${l.name ? ` "${l.name}"` : ''}`;

/**
 * The element a step acts on: a saved element of the application (shared — fix it once, every step follows) or
 * the step's own ranked locators, which can be saved as a new element.
 */
export function ElementField({ value, onChange }: { value: Locator[]; onChange: (v: Locator[]) => void }) {
  const { applicationId, elements } = useEditorCtx();
  const ref = value[0]?.strategy === 'element' ? value[0] : null;
  const element = ref ? elements.find((e) => e.id === ref.value) : undefined;
  const [saving, setSaving] = useState(false);
  const pages = [...new Set(elements.map((e) => e.page || 'Other'))];

  return (
    <div className="space-y-2" role="group" aria-label="Element">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Saved element" className="min-w-64 flex-1">
          <Select
            aria-label="Saved element"
            value={ref?.value ?? ''}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? [{ strategy: 'element', value: e.target.value }]
                  : // Back to own locators: start from the element's locators so nothing is lost.
                    (element?.locatorsJson ?? value.filter((l) => l.strategy !== 'element')),
              )
            }
          >
            <option value="">— This step's own locators —</option>
            {pages.map((p) => (
              <optgroup key={p} label={p}>
                {elements
                  .filter((e) => (e.page || 'Other') === p)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {!ref && value.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setSaving(true)}>
            <BookmarkPlus className="h-3.5 w-3.5" /> Save as element
          </Button>
        )}
        {ref && element && (
          <Button
            variant="ghost"
            size="sm"
            title="Copy the element's locators into this step (it stops following the element)"
            onClick={() => onChange(element.locatorsJson)}
          >
            <Unlink className="h-3.5 w-3.5" /> Detach
          </Button>
        )}
      </div>

      {ref ? (
        element ? (
          <div
            className="rounded-lg border border-border bg-fg/[0.02] p-3 text-xs"
            data-testid="element-info"
          >
            <p className="flex flex-wrap items-center gap-1.5">
              <Crosshair className="h-3.5 w-3.5 text-brand" />
              <b className="text-sm">{element.name}</b>
              {element.page && <span className="text-muted">· {element.page}</span>}
              <span className="text-muted">
                · used by {element.usedBySteps} step{element.usedBySteps === 1 ? '' : 's'}: fix it once and
                every one of them follows
              </span>
              <Link
                to="/applications/$appId"
                params={{ appId: applicationId }}
                search={{ tab: 'elements', element: element.id }}
                className="ml-auto text-brand hover:underline"
              >
                Edit element
              </Link>
            </p>
            <ol className="mt-2 space-y-0.5 font-mono text-muted">
              {element.locatorsJson.map((l, i) => (
                <li key={i}>
                  {i === 0 ? '★ ' : '  '}
                  {describe(l)}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-xs text-fail">This step uses an element that was deleted. Choose another one.</p>
        )
      ) : (
        <>
          <span className="text-xs text-muted">
            Ranked locators — the first one is used, the rest heal it. Save them as an element to share them.
          </span>
          <LocatorEditor value={value} onChange={onChange} />
        </>
      )}
      {saving && (
        <SaveElementDialog
          applicationId={applicationId}
          locators={value}
          pages={pages.filter((p) => p !== 'Other')}
          onClose={() => setSaving(false)}
          onSaved={(e) => {
            onChange([{ strategy: 'element', value: e.id }]);
            setSaving(false);
          }}
        />
      )}
    </div>
  );
}

function SaveElementDialog({
  applicationId,
  locators,
  pages,
  onClose,
  onSaved,
}: {
  applicationId: string;
  locators: Locator[];
  pages: string[];
  onClose: () => void;
  onSaved: (e: ElementOption) => void;
}) {
  const qc = useQueryClient();
  const first = locators[0];
  const [name, setName] = useState(first?.name ?? (first && first.strategy !== 'css' ? first.value : ''));
  const [page, setPage] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<ElementOption>(`/api/applications/${applicationId}/elements`, {
        method: 'POST',
        json: { name, page, locators },
      }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['elements', applicationId] });
      toast(`Element "${e.name}" saved — save the steps to use it`);
      onSaved(e);
    },
    onError: toastError,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as element"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save element
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field label="Element name">
          <Input autoFocus aria-label="Element name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Page (optional)" hint="Groups elements, e.g. Login or New patient">
          <Input
            aria-label="Element page"
            list="element-pages"
            value={page}
            onChange={(e) => setPage(e.target.value)}
          />
          <datalist id="element-pages">
            {pages.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <p className="text-xs text-muted">
          The step's {locators.length} locator{locators.length === 1 ? '' : 's'} become the element's. Other
          steps can then use the same element.
        </p>
      </form>
    </Dialog>
  );
}
