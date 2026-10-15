import { slugify } from '@stepforge/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import type { Application } from '@/lib/types';
import { cn } from '@/lib/utils';

export const APP_COLORS = [
  '#F97316',
  '#6366F1',
  '#22C55E',
  '#0EA5E9',
  '#EC4899',
  '#EAB308',
  '#14B8A6',
  '#A855F7',
];
export const APP_CATEGORIES = [
  'web',
  'healthcare',
  'e-commerce',
  'finance',
  'saas',
  'education',
  'internal',
  'other',
];

export type AppFormValues = {
  name: string;
  slug: string;
  description: string;
  category: string;
  color: string;
  platform: Application['platform'];
};

export function AppFormDialog({
  open,
  onClose,
  onSubmit,
  initial,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (v: AppFormValues) => void;
  initial?: Application;
  busy?: boolean;
  error?: string;
}) {
  const [v, setV] = useState<AppFormValues>(() => ({
    name: initial?.name ?? '',
    slug: initial?.slug ?? '',
    description: initial?.description ?? '',
    category: initial?.category ?? 'web',
    color: initial?.color ?? APP_COLORS[0]!,
    platform: initial?.platform ?? 'web',
  }));
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const set = (patch: Partial<AppFormValues>) => setV((cur) => ({ ...cur, ...patch }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? 'Edit application' : 'New application'}
      description="An application under test: a web app, a desktop or phone app, an API or all of them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!v.name.trim() || !v.slug || busy} onClick={() => onSubmit(v)}>
            {initial ? 'Save changes' : 'Create application'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.name.trim() && v.slug) onSubmit(v);
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            value={v.name}
            placeholder="e.g. CareClinic"
            onChange={(e) =>
              set({ name: e.target.value, ...(!slugTouched && { slug: slugify(e.target.value) }) })
            }
          />
        </Field>
        <Field label="Slug" hint="Used by the CLI, e.g. stepforge run --app careclinic">
          <Input
            value={v.slug}
            className="font-mono"
            onChange={(e) => {
              setSlugTouched(true);
              set({ slug: e.target.value.toLowerCase() });
            }}
          />
        </Field>
        <Field
          label="Platform"
          hint={
            v.platform === 'electron'
              ? 'Each environment says which app to start (its executable or project folder).'
              : v.platform === 'android'
                ? 'Each environment says which app (.apk) and which emulator or phone; tests run through Appium.'
                : v.platform === 'ios'
                  ? 'Each environment says which app and which simulator or iPhone; needs a Mac with Xcode.'
                  : v.platform === 'macos'
                    ? 'A native Mac app, by bundle id or .app; tested on a Mac with Xcode.'
                    : v.platform === 'windows'
                      ? 'A native Windows app (.exe or Store app); tested on Windows 10 or 11.'
                      : v.platform === 'linux'
                        ? 'A GTK or Qt app, started by its command; tested on Linux with a display.'
                        : 'Tests open the app in a browser at the environment’s address.'
          }
        >
          <Select
            aria-label="Platform"
            value={v.platform}
            onChange={(e) => set({ platform: e.target.value as Application['platform'] })}
          >
            <option value="web">Web app (in a browser)</option>
            <option value="electron">Desktop app (Electron)</option>
            <option value="android">Android app</option>
            <option value="ios">iOS app (iPhone, iPad)</option>
            <option value="macos">macOS app</option>
            <option value="windows">Windows app</option>
            <option value="linux">Linux app (GTK, Qt)</option>
          </Select>
        </Field>
        <Field label="Description">
          <Textarea value={v.description} rows={2} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Category">
            <Select value={v.category} onChange={(e) => set({ category: e.target.value })}>
              {APP_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">Colour</span>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {APP_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                  className={cn(
                    'h-6 w-6 rounded-full ring-offset-2 ring-offset-elevated',
                    v.color === c && 'ring-2 ring-fg/60',
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </div>
        {error && <p className="text-sm text-fail">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function AppAvatar({ app, size = 40 }: { app: Pick<Application, 'name' | 'color'>; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${app.color}, ${app.color}aa)`,
        fontSize: size * 0.4,
      }}
    >
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
