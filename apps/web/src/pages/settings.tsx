import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { MailpitCard } from '@/components/email/mailpit-card';
import { K6Card } from '@/components/perf/k6-card';
import { AiCard, ReportBrandingCard } from '@/components/settings/report-cards';
import { PageHeader } from '@/components/shell/layout';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { api, type Settings } from '@/lib/api';
import { applyTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const save = useMutation({
    mutationFn: ({ key, value }: { key: keyof Settings; value: unknown }) =>
      api(`/api/settings/${key}`, { method: 'PUT', json: { value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  return (
    <>
      <PageHeader title="Settings" description="Preferences are stored locally in your StepForge database." />
      {settings.isError && <ErrorState error={settings.error} onRetry={() => settings.refetch()} />}
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardBody>
            {settings.isPending ? (
              <Skeleton className="h-10 w-72" />
            ) : (
              <div
                className="inline-flex rounded-lg border border-border bg-bg p-1"
                role="radiogroup"
                aria-label="Theme"
              >
                {THEMES.map((t) => {
                  const active = settings.data?.theme === t.value;
                  return (
                    <button
                      key={t.value}
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        applyTheme(t.value);
                        save.mutate({ key: 'theme', value: t.value });
                      }}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3.5 py-1.5 text-sm text-muted transition-colors',
                        active && 'bg-surface text-fg shadow-sm',
                      )}
                    >
                      <t.icon className="h-4 w-4" /> {t.label}
                    </button>
                  );
                })}
              </div>
            )}
            {save.isError && <p className="mt-2 text-sm text-fail">{(save.error as Error).message}</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Runner defaults</CardTitle>
          </CardHeader>
          <CardBody className="grid grid-cols-2 gap-3 text-sm">
            {settings.data &&
              (
                [
                  ['Browser', settings.data.defaultBrowser],
                  ['Viewport', settings.data.defaultViewport],
                  ['Default timeout', `${settings.data.defaultTimeoutMs} ms`],
                  ['Parallel workers', String(settings.data.workers)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-xs text-muted">{k}</div>
                  <div className="font-mono text-sm">{v}</div>
                </div>
              ))}
            <p className="col-span-2 text-xs text-muted">
              Editable runner and retention settings arrive with their phases.
            </p>
          </CardBody>
        </Card>
        <MailpitCard />
        <K6Card />
        <ReportBrandingCard settings={settings.data} />
        <AiCard settings={settings.data} />
      </div>
    </>
  );
}
