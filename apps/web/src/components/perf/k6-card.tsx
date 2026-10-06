import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Gauge } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';

type K6Status = { available: boolean; path: string | null; version: string | null };

/** Settings → Performance: optional k6 (the built-in engine needs nothing). */
export function K6Card() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['k6'], queryFn: () => api<K6Status>('/api/perf/k6') });
  const [path, setPath] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['k6'] });
    void qc.invalidateQueries({ queryKey: ['perf-info'] });
  };
  const install = useMutation({
    mutationFn: () => api<K6Status>('/api/perf/k6/install', { method: 'POST' }),
    onSuccess: () => {
      refresh();
      toast('k6 installed');
    },
    onError: toastError,
  });
  const savePath = useMutation({
    mutationFn: () => api<K6Status>('/api/perf/k6/path', { method: 'PUT', json: { path } }),
    onSuccess: (s) => {
      refresh();
      toast(s.available ? `Using k6 ${s.version ?? ''}` : 'k6 was not found at that path');
    },
    onError: toastError,
  });
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4" /> Performance (k6)
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Load tests run on the built-in engine. k6 is optional: install it to run tests with k6 too. Exported
          k6 scripts work without it.
        </p>
        {status.isPending ? (
          <Skeleton className="h-10" />
        ) : (
          s && (
            <div className="flex flex-wrap items-center gap-2" data-testid="k6-status">
              {s.available ? <Badge tone="pass">k6 {s.version}</Badge> : <Badge>k6 not found</Badge>}
              {s.path && <span className="font-mono text-xs text-muted">{s.path}</span>}
              {!s.available && (
                <Button size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
                  <Download className="h-3.5 w-3.5" /> {install.isPending ? 'Downloading…' : 'Install k6'}
                </Button>
              )}
            </div>
          )
        )}
        <div className="flex items-end gap-2">
          <Field label="Or use k6 from this path" className="flex-1">
            <Input
              className="font-mono text-xs"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\\Tools\\k6.exe"
            />
          </Field>
          <Button
            variant="outline"
            size="sm"
            className="mb-0.5"
            disabled={savePath.isPending}
            onClick={() => savePath.mutate()}
          >
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
