import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AppWindow, Plus, ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { AppAvatar, AppFormDialog, type AppFormValues } from '@/components/applications/app-form';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { qk, useApplications } from '@/lib/queries';
import type { Application } from '@/lib/types';

export function ApplicationsPage() {
  const apps = useApplications();
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (v: AppFormValues) => api<Application>('/api/applications', { method: 'POST', json: v }),
    onSuccess: (app) => {
      qc.invalidateQueries({ queryKey: qk.applications });
      setCurrentAppId(app.id);
      setCreating(false);
      toast(`Created ${app.name}`);
      navigate({ to: '/applications/$appId', params: { appId: app.id } });
    },
  });

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every application under test, with its environments, secrets and test tree."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New application
          </Button>
        }
      />
      {apps.isError && <ErrorState error={apps.error} onRetry={() => apps.refetch()} />}
      {apps.isPending && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      )}
      {apps.data?.length === 0 && (
        <EmptyState
          icon={AppWindow}
          title="No applications yet"
          description="Add the web app or API you want to test. You can give it Local, Staging and Production environments, secrets and a tree of test modules."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Create your first application
            </Button>
          }
        />
      )}
      {!!apps.data?.length && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {apps.data.map((a, i) => (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <Link
                to="/applications/$appId"
                params={{ appId: a.id }}
                onClick={() => setCurrentAppId(a.id)}
                className="block focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Card className="group h-full p-5 transition-colors hover:border-fg/15">
                  <div className="flex items-start gap-3">
                    <AppAvatar app={a} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">{a.name}</h3>
                        {a.hasProduction && (
                          <Badge tone="fail" title="Has a production environment">
                            <ShieldAlert className="h-3 w-3" /> PROD
                          </Badge>
                        )}
                      </div>
                      <p className="font-mono text-xs text-muted">{a.slug}</p>
                    </div>
                    <Badge>{a.category}</Badge>
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted">
                    {a.description || 'No description'}
                  </p>
                  <div className="mt-4 grid grid-cols-4 gap-2 border-t border-border pt-3 text-center">
                    {(
                      [
                        ['Envs', a.counts.environments],
                        ['Modules', a.counts.modules],
                        ['Scenarios', a.counts.scenarios],
                        ['Cases', a.counts.testCases],
                      ] as const
                    ).map(([label, n]) => (
                      <div key={label}>
                        <div className="font-mono text-base font-semibold tabular-nums">{n}</div>
                        <div className="text-[11px] text-muted">{label}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
      {creating && (
        <AppFormDialog
          open
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
          busy={create.isPending}
          error={create.error?.message}
        />
      )}
    </>
  );
}
