import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Code2,
  Download,
  Eye,
  FileCode2,
  FileText,
  Folder,
  PackageOpen,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CodeEditor } from '@/components/editor/code-editor';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select, Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api, ApiError, download, sessionToken } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { useCurrentApp, useEnvironments, useTags, useTree } from '@/lib/queries';
import type { CodegenPreview, CodegenTarget, ExportRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type Scope =
  | { type: 'application' }
  | { type: 'module'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'scenarios'; ids: string[] };

const LANG: Record<string, Parameters<typeof CodeEditor>[0]['language']> = {
  ts: 'typescript',
  js: 'javascript',
  cjs: 'javascript',
  py: 'python',
  java: 'java',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  xml: 'xml',
  sh: 'shell',
  sql: 'sql',
  feature: 'plaintext',
};
const languageOf = (path: string) => LANG[path.split('.').pop() ?? ''] ?? 'plaintext';
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** POST then save the response (the session token goes in a header, so a plain link cannot be used). */
async function saveDownload(path: string, body: unknown): Promise<string> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-stepforge-token': sessionToken(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? 'http_error', b.message ?? `Export failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

function TargetPicker({
  targets,
  value,
  onChange,
}: {
  targets: CodegenTarget[];
  value: string;
  onChange: (id: string) => void;
}) {
  const groups = [...new Set(targets.map((t) => t.group))];
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Export target">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1.5 text-xs font-medium text-muted">{g}</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {targets
              .filter((t) => t.group === g)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={value === t.id}
                  onClick={() => onChange(t.id)}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    value === t.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-surface-2/60',
                  )}
                >
                  <span className="font-medium">{t.label}</span>
                  <span className="text-xs text-muted">{t.language}</span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const FIRST_FILE = [
  /\.spec\.ts$|\.cy\.js$|\/test_[^/]+\.py$|Test\.java$/,
  /\.feature$/,
  /(^|\/)script\.js$|requests\.sh$/,
  /postman_collection\.json$/,
  /test-cases\.md$/,
  /README\.md$/,
];

function Preview({ preview }: { preview: CodegenPreview }) {
  const textFiles = preview.files.filter((f) => !f.binary);
  // Open the most interesting file first: a test, then a feature/script/collection/document, then the README.
  const firstTest =
    FIRST_FILE.map((re) => textFiles.find((f) => !f.path.startsWith('.github/') && re.test(f.path))).find(
      Boolean,
    ) ?? textFiles[0];
  const [path, setPath] = useState(firstTest?.path ?? '');
  useEffect(() => setPath(firstTest?.path ?? ''), [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = preview.files.find((f) => f.path === path);
  return (
    <div className="grid min-h-[480px] grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]">
      <ul
        className="max-h-[560px] space-y-0.5 overflow-auto text-xs"
        aria-label="Generated files"
        data-testid="export-files"
      >
        {preview.files.map((f) => {
          const depth = f.path.split('/').length - 1;
          return (
            <li key={f.path}>
              <button
                type="button"
                disabled={f.binary}
                onClick={() => setPath(f.path)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono',
                  f.path === path ? 'bg-brand/10 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                )}
                style={{ paddingLeft: 8 + depth * 10 }}
                title={f.path}
              >
                {depth ? (
                  <FileCode2 className="h-3 w-3 shrink-0" />
                ) : (
                  <FileText className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{f.path}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted/70">{kb(f.size)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-w-0">
        {file?.binary ? (
          <EmptyState icon={FileText} title={file.path} description="A binary file (download to open it)." />
        ) : file ? (
          <>
            <div className="mb-1 flex items-center gap-2 font-mono text-xs text-muted">
              <Folder className="h-3.5 w-3.5" /> {file.path}
            </div>
            <CodeEditor
              key={file.path}
              ariaLabel="Generated file"
              value={file.content ?? ''}
              onChange={() => undefined}
              language={languageOf(file.path)}
              height={520}
              lineNumbers
              readOnly
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ExportsPage() {
  const qc = useQueryClient();
  const search = useSearch({ strict: false }) as { scenario?: string };
  const { app, apps } = useCurrentApp();
  const envs = useEnvironments(app?.id);
  const tags = useTags(app?.id);
  const tree = useTree(app?.id);
  const targets = useQuery({
    queryKey: ['codegen-targets'],
    queryFn: () => api<CodegenTarget[]>('/api/codegen/targets'),
  });
  const history = useQuery({
    queryKey: ['exports', app?.id],
    enabled: !!app,
    queryFn: () => api<ExportRecord[]>(`/api/exports?applicationId=${app!.id}`),
  });
  const [target, setTarget] = useState('playwright-ts');
  const [environmentId, setEnvironmentId] = useState('');
  const [scope, setScope] = useState<Scope>(
    search.scenario ? { type: 'scenarios', ids: [search.scenario] } : { type: 'application' },
  );
  const [pom, setPom] = useState(false);
  const [ci, setCi] = useState<string[]>(['github']);
  const [preview, setPreview] = useState<CodegenPreview | null>(null);
  const info = targets.data?.find((t) => t.id === target);

  useEffect(() => {
    if (envs.data?.length && !envs.data.some((e) => e.id === environmentId))
      setEnvironmentId(envs.data[0]!.id);
  }, [envs.data, environmentId]);
  useEffect(() => setPreview(null), [target, environmentId, scope, pom, ci, app?.id]);

  const body = useMemo(
    () => ({
      target,
      environmentId: environmentId || undefined,
      scope,
      pom: !!info?.pom && pom,
      ci: info?.ci ? ci : [],
    }),
    [target, environmentId, scope, pom, ci, info],
  );
  const run = useMutation({
    mutationFn: () =>
      api<CodegenPreview>(`/api/applications/${app!.id}/codegen/preview`, { method: 'POST', json: body }),
    onSuccess: setPreview,
    onError: toastError,
  });
  const save = useMutation({
    mutationFn: () => saveDownload(`/api/applications/${app!.id}/codegen/download`, body),
    onSuccess: (name) => {
      toast(`Downloaded ${name}`);
      void qc.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: toastError,
  });

  const scopeValue =
    scope.type === 'application'
      ? 'all'
      : scope.type === 'scenarios'
        ? 'picked'
        : `${scope.type}:${scope.id}`;
  const scenarios = tree.data?.scenarios ?? [];
  const picked = scope.type === 'scenarios' ? scope.ids : [];

  if (apps.isSuccess && !app)
    return (
      <div>
        <PageHeader
          title="Exports"
          description="Turn scenarios into ready-to-run test projects and documents."
        />
        <EmptyState
          icon={PackageOpen}
          title="No applications yet"
          description="Create an application with scenarios to export them."
        />
      </div>
    );

  return (
    <div>
      <PageHeader
        title="Exports"
        description="Turn scenarios into ready-to-run projects for Playwright, Cypress, Selenium and API tools, or into test documentation."
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[420px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code2 className="h-4 w-4" /> What to export
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Application">
                <Select
                  aria-label="Application"
                  value={app?.id ?? ''}
                  onChange={(e) => setCurrentAppId(e.target.value)}
                >
                  {apps.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Environment" hint="Base URL and variables become defaults">
                <Select
                  aria-label="Environment"
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                >
                  {envs.data?.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Tests">
              <Select
                aria-label="Tests to export"
                value={scopeValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'all') setScope({ type: 'application' });
                  else if (v === 'picked')
                    setScope({
                      type: 'scenarios',
                      ids: picked.length ? picked : scenarios.slice(0, 1).map((x) => x.id),
                    });
                  else {
                    const [type, id] = v.split(':') as ['module' | 'tag', string];
                    setScope({ type, id });
                  }
                }}
              >
                <option value="all">All scenarios ({scenarios.length})</option>
                <option value="picked">Chosen scenarios…</option>
                {tree.data?.modules.length ? (
                  <optgroup label="Module">
                    {tree.data.modules.map((m) => (
                      <option key={m.id} value={`module:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {tags.data?.length ? (
                  <optgroup label="Tag">
                    {tags.data.map((t) => (
                      <option key={t.id} value={`tag:${t.id}`}>
                        #{t.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            </Field>
            {scope.type === 'scenarios' && (
              <ul
                className="max-h-40 space-y-1 overflow-auto rounded-lg border border-border p-2"
                aria-label="Scenarios to export"
              >
                {scenarios.map((sc) => (
                  <li key={sc.id}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={picked.includes(sc.id)}
                        onChange={(e) =>
                          setScope({
                            type: 'scenarios',
                            ids: e.target.checked ? [...picked, sc.id] : picked.filter((x) => x !== sc.id),
                          })
                        }
                      />
                      <span className="truncate">{sc.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {targets.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <TargetPicker targets={targets.data ?? []} value={target} onChange={setTarget} />
            )}
            {(info?.pom || info?.ci) && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                {info.pom && (
                  <label className="flex items-center gap-2">
                    <Switch label="Page Object Model" checked={pom} onChange={setPom} />
                    Page Object Model{' '}
                    <span className="text-xs text-muted">
                      (one class per page instead of inline locators)
                    </span>
                  </label>
                )}
                {info.ci && (
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-xs text-muted">CI files</span>
                    {(['github', 'gitlab'] as const).map((p) => (
                      <label key={p} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={ci.includes(p)}
                          onChange={(e) => setCi(e.target.checked ? [...ci, p] : ci.filter((x) => x !== p))}
                        />
                        {p === 'github' ? 'GitHub Actions' : 'GitLab CI'}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted">
              Secret values are never exported: the project reads them from environment variables (listed in
              its .env.example). Steps that cannot be translated exactly are marked{' '}
              <code>TODO(StepForge)</code> and listed before you download.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!app || run.isPending || (scope.type === 'scenarios' && !picked.length)}
                onClick={() => run.mutate()}
              >
                <Eye className="h-4 w-4" /> Preview
              </Button>
              <Button
                disabled={!app || save.isPending || (scope.type === 'scenarios' && !picked.length)}
                onClick={() => save.mutate()}
              >
                <Download className="h-4 w-4" /> Download
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4" />{' '}
              {preview
                ? `${info?.label} · ${preview.files.length} files · ${preview.scenarios} scenarios`
                : 'Preview'}
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {run.isPending ? (
              <Skeleton className="h-96 w-full" />
            ) : !preview ? (
              <EmptyState
                icon={Eye}
                title="Nothing to preview yet"
                description="Choose what to export and press Preview to see every generated file."
              />
            ) : (
              <>
                {preview.warnings.length > 0 && (
                  <div
                    className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm"
                    data-testid="export-warnings"
                  >
                    <div className="mb-1 flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4 text-warn" />
                      {preview.warnings.length === 1
                        ? '1 step needs attention'
                        : `${preview.warnings.length} steps need attention`}
                    </div>
                    <ul className="list-disc space-y-0.5 pl-5 text-xs">
                      {preview.warnings.map((w, i) => (
                        <li key={i}>
                          {w.scenario && <strong>{w.scenario}</strong>}
                          {w.step && <span className="text-muted"> — {w.step}</span>}: {w.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2 font-mono text-xs">
                  <Terminal className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate" data-testid="export-run">
                    {preview.run}
                  </span>
                </div>
                <Preview preview={preview} />
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Earlier exports</CardTitle>
        </CardHeader>
        <CardBody>
          {!history.data?.length ? (
            <p className="text-sm text-muted">Downloads are kept here so you can get them again.</p>
          ) : (
            <table className="w-full text-sm" data-testid="export-history">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 font-medium">When</th>
                  <th className="py-1 font-medium">Target</th>
                  <th className="py-1 font-medium">Scenarios</th>
                  <th className="py-1 font-medium">Warnings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.data.map((e) => (
                  <tr key={e.id} className="border-t border-border/60">
                    <td className="py-1.5 text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="py-1.5">{targets.data?.find((t) => t.id === e.kind)?.label ?? e.kind}</td>
                    <td className="py-1.5">{e.optionsJson.scenarios}</td>
                    <td className="py-1.5">
                      {e.optionsJson.warnings ? <Badge tone="warn">{e.optionsJson.warnings}</Badge> : '—'}
                    </td>
                    <td className="py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Download ${e.optionsJson.filename} again`}
                        onClick={() => download(`/api/exports/${e.id}/file`)}
                      >
                        <Download className="h-3.5 w-3.5" /> {e.optionsJson.filename}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
