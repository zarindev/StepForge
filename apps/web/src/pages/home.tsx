import { useQuery } from '@tanstack/react-query';
import { AppWindow, Bug, FileCheck2, Layers, PlayCircle, Sparkles } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { PageHeader } from '@/components/shell/layout';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api, type SystemInfo } from '@/lib/api';

const KPIS = [
  { key: 'applications', label: 'Applications', icon: AppWindow, tint: 'text-brand bg-brand/10' },
  { key: 'scenarios', label: 'Scenarios', icon: Layers, tint: 'text-indigo bg-indigo/10' },
  { key: 'testCases', label: 'Test cases', icon: FileCheck2, tint: 'text-pass bg-pass/10' },
  { key: 'runs', label: 'Runs', icon: PlayCircle, tint: 'text-sky-400 bg-sky-400/10' },
  { key: 'openBugs', label: 'Bugs', icon: Bug, tint: 'text-fail bg-fail/10' },
] as const;

export function HomePage() {
  const system = useQuery({ queryKey: ['system'], queryFn: () => api<SystemInfo>('/api/system') });

  return (
    <>
      <PageHeader title="Home" description="Quality across every application, layer and environment." />

      {system.isError && <ErrorState error={system.error} onRetry={() => system.refetch()} />}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {KPIS.map((k, i) => (
          <motion.div
            key={k.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
          >
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">{k.label}</span>
                <span className={`grid h-7 w-7 place-items-center rounded-lg ${k.tint}`}>
                  <k.icon className="h-3.5 w-3.5" />
                </span>
              </div>
              {system.isPending ? (
                <Skeleton className="mt-3 h-7 w-12" />
              ) : (
                <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {system.data?.counts[k.key] ?? '—'}
                </div>
              )}
            </Card>
          </motion.div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <EmptyState
            icon={Sparkles}
            title="Welcome to StepForge"
            description="Your local QA studio is running. Add an application to start organising, recording and running tests. Trends, quality gates and recent runs will appear here as soon as you have results."
            action={
              <Link to={system.data?.counts.applications ? '/explorer' : '/applications'}>
                <Button>
                  {system.data?.counts.applications
                    ? 'Open the Test Explorer'
                    : 'Create your first application'}
                </Button>
              </Link>
            }
          />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Local workspace</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2.5 text-sm">
            {system.isPending ? (
              <>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </>
            ) : system.data ? (
              <>
                <Row label="Version" value={system.data.version} />
                <Row label="Node.js" value={system.data.node} />
                <Row label="Platform" value={system.data.platform} />
                <Row label="Data folder" value={system.data.dataDir} />
                <Row
                  label="Step types"
                  value={String(Object.values(system.data.stepCatalogue).reduce((n, s) => n + s.length, 0))}
                />
              </>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="truncate font-mono text-xs leading-5" title={value}>
        {value}
      </span>
    </div>
  );
}
