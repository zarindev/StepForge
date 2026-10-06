import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { artifactUrl, traceViewerUrl } from '@/lib/api';
import type { Artifact } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FileVideo } from 'lucide-react';

type ConsoleEntry = { type: string; text: string; location?: string };
type NetworkEntry = {
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  durationMs?: number;
  failure?: string;
};

function useJsonArtifact<T>(a: Artifact | undefined) {
  return useQuery({
    queryKey: ['artifact-json', a?.path],
    queryFn: async () => (await fetch(artifactUrl(a!.path))).json() as Promise<T>,
    enabled: !!a,
    staleTime: Infinity,
  });
}

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!src} onClose={onClose} title="Screenshot" size="lg">
      {src && <img src={src} alt="Step screenshot" className="w-full rounded-lg border border-border" />}
    </Dialog>
  );
}

export function EvidencePanel({ artifacts }: { artifacts: Artifact[] }) {
  const by = (k: string) => artifacts.find((a) => a.kind === k);
  const video = by('video');
  const trace = by('trace');
  const tabs = [
    { value: 'video' as const, label: 'Video', show: !!video },
    { value: 'trace' as const, label: 'Trace', show: !!trace },
    { value: 'console' as const, label: 'Console', show: !!by('console') },
    { value: 'network' as const, label: 'Network', show: !!by('network') },
  ].filter((t) => t.show);
  const [tab, setTab] = useState<(typeof tabs)[number]['value'] | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const active = tab && tabs.some((t) => t.value === tab) ? tab : tabs[0]?.value;
  const consoleLog = useJsonArtifact<ConsoleEntry[]>(active === 'console' ? by('console') : undefined);
  const network = useJsonArtifact<NetworkEntry[]>(active === 'network' ? by('network') : undefined);

  if (!tabs.length) {
    return (
      <EmptyState
        icon={FileVideo}
        title="No evidence kept"
        description="Video and trace are kept on failure by default. Change this in the run options."
      />
    );
  }
  return (
    <div>
      <Tabs tabs={tabs} value={active!} onChange={setTab} className="mb-3" />
      {active === 'video' && video && (
        <video
          key={video.path}
          controls
          src={artifactUrl(video.path)}
          className="w-full rounded-lg border border-border bg-black"
          aria-label="Test video"
        />
      )}
      {active === 'trace' && trace && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            The Playwright trace has a DOM snapshot, network calls and console output for every action. It
            opens in Playwright's Trace Viewer, served from your machine.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => setTraceOpen(true)}>
              <Maximize2 className="h-4 w-4" /> Open Trace Viewer
            </Button>
            <a href={traceViewerUrl(trace.path)} target="_blank" rel="noreferrer">
              <Button variant="outline">
                <ExternalLink className="h-4 w-4" /> New tab
              </Button>
            </a>
            <a href={artifactUrl(trace.path)} download="trace.zip">
              <Button variant="ghost">Download trace.zip</Button>
            </a>
          </div>
          {traceOpen && (
            <div className="fixed inset-0 z-50 flex flex-col bg-bg">
              <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
                <span className="font-medium">Playwright Trace Viewer</span>
                <Button variant="ghost" size="sm" onClick={() => setTraceOpen(false)}>
                  Close
                </Button>
              </div>
              <iframe title="Trace Viewer" src={traceViewerUrl(trace.path)} className="flex-1 border-0" />
            </div>
          )}
        </div>
      )}
      {active === 'console' && (
        <div className="max-h-96 overflow-auto rounded-lg border border-border bg-bg font-mono text-xs">
          {consoleLog.data?.length === 0 && <p className="p-3 text-muted">No console output.</p>}
          {consoleLog.data?.map((c, i) => (
            <div
              key={i}
              className={cn(
                'flex gap-2 border-b border-border px-3 py-1.5',
                (c.type === 'error' || c.type === 'pageerror') && 'bg-fail/5 text-fail',
                c.type === 'warning' && 'text-warn',
              )}
            >
              <span className="w-16 shrink-0 opacity-70">{c.type}</span>
              <span className="flex-1 break-all">{c.text}</span>
              {c.location && (
                <span className="shrink-0 truncate opacity-50">{c.location.split('/').pop()}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {active === 'network' && (
        <div className="max-h-96 overflow-auto rounded-lg border border-border">
          <table className="w-full font-mono text-xs">
            <thead className="sticky top-0 bg-surface text-left text-muted">
              <tr>
                <th className="px-3 py-1.5">Method</th>
                <th className="px-3 py-1.5">Status</th>
                <th className="px-3 py-1.5">URL</th>
                <th className="px-3 py-1.5">Type</th>
                <th className="px-3 py-1.5 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {network.data?.map((n, i) => (
                <tr
                  key={i}
                  className={cn(
                    'border-t border-border',
                    ((n.status ?? 0) >= 400 || n.failure) && 'bg-fail/5 text-fail',
                  )}
                >
                  <td className="px-3 py-1">{n.method}</td>
                  <td className="px-3 py-1">{n.status ?? n.failure ?? '—'}</td>
                  <td className="max-w-md truncate px-3 py-1" title={n.url}>
                    {n.url.replace(/^https?:\/\/[^/]+/, '')}
                  </td>
                  <td className="px-3 py-1">
                    <Badge>{n.resourceType}</Badge>
                  </td>
                  <td className="px-3 py-1 text-right">
                    {n.durationMs !== undefined ? `${n.durationMs} ms` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
