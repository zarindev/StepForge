import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Database,
  KeyRound,
  Play,
  Rocket,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api, download, type Settings } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { useApplications } from '@/lib/queries';

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: keyof Settings; value: unknown }) =>
      api(`/api/settings/${key}`, { method: 'PUT', json: { value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: toastError,
  });
}

/** Defaults for the Run dialog, schedules and the CLI (a run can still choose its own). */
export function RunnerDefaultsCard({ settings }: { settings?: Settings }) {
  const save = useSave();
  const [timeout, setTimeoutMs] = useState('');
  useEffect(() => {
    if (settings) setTimeoutMs(String(settings.defaultTimeoutMs));
  }, [settings]);
  if (!settings) return null;
  const set = (key: keyof Settings, value: unknown) =>
    save.mutate({ key, value }, { onSuccess: () => toast('Runner defaults saved') });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" /> Runner defaults
        </CardTitle>
      </CardHeader>
      <CardBody className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Field label="Browser">
          <Select
            aria-label="Default browser"
            value={settings.defaultBrowser}
            onChange={(e) => set('defaultBrowser', e.target.value)}
          >
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </Select>
        </Field>
        <Field label="Viewport">
          <Select
            aria-label="Default viewport"
            value={settings.defaultViewport}
            onChange={(e) => set('defaultViewport', e.target.value)}
          >
            <option value="desktop">Desktop</option>
            <option value="tablet">Tablet</option>
            <option value="mobile">Mobile</option>
          </Select>
        </Field>
        <Field label="Parallel tests">
          <Select
            aria-label="Default workers"
            value={settings.workers}
            onChange={(e) => set('workers', Number(e.target.value))}
          >
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Step timeout (ms)">
          <Input
            aria-label="Default timeout"
            type="number"
            min={1000}
            step={1000}
            value={timeout}
            onChange={(e) => setTimeoutMs(e.target.value)}
            onBlur={() => {
              const n = Number(timeout);
              if (Number.isInteger(n) && n >= 1000 && n !== settings.defaultTimeoutMs)
                set('defaultTimeoutMs', n);
            }}
          />
        </Field>
        <p className="col-span-full text-xs text-muted">
          Used by the Run dialog (until you change its options), schedules and the CLI.
        </p>
      </CardBody>
    </Card>
  );
}

/** Removes old evidence files daily; results and history stay. */
export function RetentionCard({ settings }: { settings?: Settings }) {
  const save = useSave();
  const [days, setDays] = useState('');
  useEffect(() => {
    if (settings) setDays(String(settings.retention.prunePassesAfterDays));
  }, [settings]);
  const prune = useMutation({
    mutationFn: () =>
      api<{ items: number; files: number; bytes: number }>('/api/maintenance/prune', { method: 'POST' }),
    onSuccess: (r) =>
      toast(
        r.files
          ? `Removed ${r.files} file(s), ${(r.bytes / 1024 / 1024).toFixed(1)} MB`
          : 'Nothing old enough to remove',
      ),
    onError: toastError,
  });
  if (!settings) return null;
  const r = settings.retention;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-4 w-4" /> Evidence retention
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Screenshots, videos and traces of old results are removed once a day. Results, timings, diagnoses
          and bugs are kept.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Remove evidence older than (days)">
            <Input
              aria-label="Retention days"
              type="number"
              min={1}
              className="w-32"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              onBlur={() => {
                const n = Number(days);
                if (Number.isInteger(n) && n >= 1 && n !== r.prunePassesAfterDays)
                  save.mutate(
                    { key: 'retention', value: { ...r, prunePassesAfterDays: n } },
                    { onSuccess: () => toast('Retention saved') },
                  );
              }}
            />
          </Field>
          <label className="flex items-center gap-2 pb-2">
            <Switch
              label="Keep evidence of failures"
              checked={r.keepFailures}
              onChange={(v) =>
                save.mutate(
                  { key: 'retention', value: { ...r, keepFailures: v } },
                  { onSuccess: () => toast('Retention saved') },
                )
              }
            />
            Keep evidence of failed tests
          </label>
          <Button size="sm" variant="outline" disabled={prune.isPending} onClick={() => prune.mutate()}>
            Clean up now
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** Demo workspace, application import/export (JSON, secret values never included). */
export function DataCard() {
  const qc = useQueryClient();
  const apps = useApplications();
  const [appId, setAppId] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const demo = useQuery({
    queryKey: ['demo'],
    queryFn: () =>
      api<{ available: boolean; loaded: boolean; clinic: { running: boolean; url: string | null } }>(
        '/api/demo',
      ),
  });
  useEffect(() => {
    if (!appId && apps.data?.[0]) setAppId(apps.data[0].id);
  }, [apps.data, appId]);
  const load = useMutation({
    mutationFn: () =>
      api<{ applicationId: string; clinicUrl: string; created: boolean }>('/api/demo/load', {
        method: 'POST',
      }),
    onSuccess: (r) => {
      setCurrentAppId(r.applicationId);
      void qc.invalidateQueries();
      toast(
        r.created
          ? `Demo workspace loaded; CareClinic at ${r.clinicUrl}`
          : `CareClinic is running at ${r.clinicUrl}`,
      );
    },
    onError: toastError,
  });
  const importApp = useMutation({
    mutationFn: async (f: File) => {
      let data: unknown;
      try {
        data = JSON.parse(await f.text());
      } catch {
        throw new Error(`${f.name} is not a JSON file`);
      }
      return api<{
        applicationId: string;
        slug: string;
        counts: { scenarios: number };
        missingSecrets: { environment: string; keys: string[] }[];
      }>('/api/applications/import', { method: 'POST', json: data });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries();
      setCurrentAppId(r.applicationId);
      const missing = r.missingSecrets.flatMap((m) => m.keys.map((k) => `${m.environment}: ${k}`));
      toast(
        `Imported ${r.slug} (${r.counts.scenarios} scenarios)${missing.length ? `. Enter these secrets again: ${missing.join(', ')}` : ''}`,
      );
    },
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4" /> Applications and demo
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Rocket className="h-4 w-4 text-brand" />
          <span className="flex-1 text-muted">
            Demo workspace (CareClinic):{' '}
            {demo.data?.loaded
              ? demo.data.clinic.running
                ? `loaded, running at ${demo.data.clinic.url}`
                : 'loaded, demo app stopped'
              : 'not loaded'}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!demo.data?.available || load.isPending}
            onClick={() => load.mutate()}
          >
            {demo.data?.loaded ? (
              <>
                <Play className="h-3.5 w-3.5" /> Start CareClinic
              </>
            ) : (
              'Load demo workspace'
            )}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
          <Field label="Export an application (JSON, no secret values)">
            <Select
              aria-label="Application to export"
              className="w-56"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            >
              {apps.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            size="sm"
            variant="outline"
            disabled={!appId}
            onClick={() => download(`/api/applications/${appId}/export`)}
          >
            Export
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Application file to import"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importApp.mutate(f);
              e.target.value = '';
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={importApp.isPending}
            onClick={() => file.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" /> Import an application…
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** Master-key rotation and the danger zone. */
export function SecurityCard() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<'rotate' | 'history' | 'everything' | null>(null);
  const rotate = useMutation({
    mutationFn: () =>
      api<{ secrets: number; backup: string }>('/api/maintenance/rotate-key', { method: 'POST' }),
    onSuccess: (r) =>
      toast(
        `New encryption key; ${r.secrets} secret(s) re-encrypted. Old key kept as ${r.backup.split(/[\\/]/).pop()}`,
      ),
    onError: toastError,
  });
  const wipe = useMutation({
    mutationFn: ({ kind, typed }: { kind: 'history' | 'everything'; typed: string }) =>
      api<{ runs?: number; applications?: number }>(`/api/maintenance/delete-${kind}`, {
        method: 'POST',
        json: { confirm: typed },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast(
        r.applications !== undefined
          ? `Deleted ${r.applications} application(s) and all history`
          : `Deleted ${r.runs} run(s)`,
      );
    },
    onError: toastError,
  });
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Encryption key
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <p className="flex-1 text-muted">
            Secrets (passwords, tokens) are encrypted with AES-256-GCM using the key in <code>data/.key</code>
            . Rotating creates a new key and re-encrypts every secret; the old key is kept as a backup file.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => setConfirm('rotate')}
          >
            Rotate key
          </Button>
        </CardBody>
      </Card>
      <Card className="border-fail/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-fail">
            <TriangleAlert className="h-4 w-4" /> Danger zone
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-muted">
              Delete all runs, results, evidence and bugs. Applications and tests stay.
            </p>
            <Button size="sm" variant="danger" onClick={() => setConfirm('history')}>
              Delete run history
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <p className="flex-1 text-muted">
              Delete every application with its tests, environments, secrets and history. Settings stay.
            </p>
            <Button size="sm" variant="danger" onClick={() => setConfirm('everything')}>
              Delete everything
            </Button>
          </div>
        </CardBody>
      </Card>
      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Rotate the encryption key?"
        description="Every secret is re-encrypted with a new key. Keep a backup of the data folder if you copy it between computers."
        confirmLabel="Rotate"
        onConfirm={() => {
          rotate.mutate();
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'history'}
        title="Delete all run history?"
        description="Runs, results, screenshots, videos, traces and bugs are deleted. This cannot be undone."
        typeToConfirm="DELETE"
        onConfirm={(typed) => {
          wipe.mutate({ kind: 'history', typed });
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'everything'}
        title="Delete everything?"
        description="All applications, tests, environments, secrets, schedules and history are deleted. This cannot be undone."
        typeToConfirm="DELETE EVERYTHING"
        onConfirm={(typed) => {
          wipe.mutate({ kind: 'everything', typed });
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
