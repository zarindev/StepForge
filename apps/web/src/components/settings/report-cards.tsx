import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api, type Settings } from '@/lib/api';

function useSaveSetting<K extends keyof Settings>(key: K, message: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: Settings[K]) => api(`/api/settings/${key}`, { method: 'PUT', json: { value } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['ai-status'] });
      toast(message);
    },
    onError: toastError,
  });
}

/** Who appears on generated reports and bug exports ("Prepared by …"). */
export function ReportBrandingCard({ settings }: { settings?: Settings }) {
  const [v, setV] = useState({ author: 'Md Zarin Tasnim', company: '', accent: '#F97316' });
  useEffect(() => {
    if (settings?.reportBranding) setV(settings.reportBranding);
  }, [settings?.reportBranding]);
  const save = useSaveSetting('reportBranding', 'Report branding saved');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" /> Reports
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Shown as “Prepared by …” on bug reports and run reports (PDF, HTML, Excel, Markdown). Every report
          also carries the “StepForge by Md Zarin Tasnim” credit.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Author">
            <Input
              aria-label="Report author"
              value={v.author}
              onChange={(e) => setV({ ...v, author: e.target.value })}
            />
          </Field>
          <Field label="Company (optional)">
            <Input
              aria-label="Company"
              value={v.company}
              onChange={(e) => setV({ ...v, company: e.target.value })}
            />
          </Field>
          <Field label="Accent colour">
            <div className="flex gap-2">
              <input
                type="color"
                aria-label="Accent colour"
                value={v.accent}
                onChange={(e) => setV({ ...v, accent: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-border bg-bg"
              />
              <Input
                className="font-mono"
                value={v.accent}
                onChange={(e) => setV({ ...v, accent: e.target.value })}
              />
            </div>
          </Field>
        </div>
        <Button
          size="sm"
          disabled={!v.author.trim() || !/^#[0-9a-fA-F]{6}$/.test(v.accent) || save.isPending}
          onClick={() => save.mutate(v)}
        >
          Save
        </Button>
      </CardBody>
    </Card>
  );
}

/** Optional local AI (Ollama) that rewrites diagnoses in plain English. Nothing leaves the computer. */
export function AiCard({ settings }: { settings?: Settings }) {
  const [v, setV] = useState({ url: 'http://localhost:11434', model: 'llama3.1' });
  useEffect(() => {
    if (settings?.ollama) setV(settings.ollama);
  }, [settings?.ollama]);
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<{ available: boolean; models?: string[]; reason?: string }>('/api/ai/status'),
  });
  const save = useSaveSetting('ollama', 'Ollama settings saved');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Local AI (optional)
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Diagnosis is rule-based and needs nothing else. If{' '}
          <a
            className="text-brand hover:underline"
            href="https://ollama.com"
            target="_blank"
            rel="noreferrer"
          >
            Ollama
          </a>{' '}
          runs on this computer with the model below, failed tests get an “Explain in plain English” button.
          Only the diagnosis (secrets already masked) is sent, and only to localhost.
        </p>
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-status">
          {status.data?.available ? (
            <Badge tone="pass">Ollama ready</Badge>
          ) : (
            <Badge>{status.data?.reason ?? 'Ollama not detected — the button stays hidden'}</Badge>
          )}
          {!!status.data?.models?.length && (
            <span className="text-xs text-muted">Models: {status.data.models.join(', ')}</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Ollama URL">
            <Input
              className="font-mono text-xs"
              value={v.url}
              onChange={(e) => setV({ ...v, url: e.target.value })}
            />
          </Field>
          <Field label="Model">
            <Input
              className="font-mono text-xs"
              value={v.model}
              onChange={(e) => setV({ ...v, model: e.target.value })}
            />
          </Field>
        </div>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(v)}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}
