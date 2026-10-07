import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2, FileJson, FileUp, Save, Send, Trash2, Webhook, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fromKV, KVEditor, toKV, type KV } from '@/components/api/kv-editor';
import { ImportDialog } from '@/components/api/import-dialog';
import { CodeEditor } from '@/components/editor/code-editor';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useCurrentApp, useEnvironments, useTree } from '@/lib/queries';
import { flattenModules } from '@/lib/tree';
import type { ScenarioDetail, StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type AuthType = 'none' | 'bearer' | 'basic' | 'apiKey';
type Draft = {
  method: string;
  url: string;
  query: KV[];
  headers: KV[];
  bodyType: 'none' | 'json' | 'form' | 'raw';
  body: string;
  auth: {
    type: AuthType;
    token?: string;
    username?: string;
    password?: string;
    name?: string;
    value?: string;
    in?: 'header' | 'query';
  };
};
type SendResult = {
  request?: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    timeMs: number;
    size: number;
  };
  contract?: { ok: boolean; operation?: string; errors: string[] } | null;
  assertions?: { passed: boolean; message: string }[];
  error?: { kind: string; message: string };
};
type Spec = { id: string; name: string; version: string; parsedJson: { operations: unknown[] } };

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_COLOR: Record<string, string> = {
  GET: 'text-pass',
  POST: 'text-warn',
  PUT: 'text-indigo',
  PATCH: 'text-indigo',
  DELETE: 'text-fail',
};
const EMPTY: Draft = {
  method: 'GET',
  url: '{{env.baseUrl}}/',
  query: [],
  headers: [],
  bodyType: 'none',
  body: '',
  auth: { type: 'none' },
};

function draftFromStep(step: StepRecord): Draft {
  const p = step.params as Record<string, unknown>;
  const body = p.body;
  const auth = (p.auth as Draft['auth']) ?? { type: 'none' };
  return {
    method: String(p.method ?? 'GET'),
    url: String(p.url ?? ''),
    query: toKV(p.query as Record<string, unknown>),
    headers: toKV(p.headers as Record<string, unknown>),
    bodyType:
      body === undefined
        ? 'none'
        : ((p.bodyType as Draft['bodyType']) ?? (typeof body === 'string' ? 'raw' : 'json')),
    body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    auth: ['bearer', 'basic', 'apiKey'].includes(auth.type) ? auth : { type: 'none' },
  };
}

function toRequest(d: Draft) {
  let body: unknown;
  if (d.bodyType === 'json') body = d.body.trim() ? JSON.parse(d.body) : undefined;
  else if (d.bodyType === 'form') body = Object.fromEntries(new URLSearchParams(d.body));
  else if (d.bodyType === 'raw') body = d.body;
  const auth =
    d.auth.type === 'bearer'
      ? { type: 'bearer', token: d.auth.token ?? '' }
      : d.auth.type === 'basic'
        ? { type: 'basic', username: d.auth.username ?? '', password: d.auth.password ?? '' }
        : d.auth.type === 'apiKey'
          ? { type: 'apiKey', in: d.auth.in ?? 'header', name: d.auth.name ?? '', value: d.auth.value ?? '' }
          : undefined;
  const query = fromKV(d.query);
  return {
    method: d.method,
    url: d.url,
    headers: fromKV(d.headers),
    ...(Object.keys(query).length && { query }),
    ...(body !== undefined && { body, bodyType: d.bodyType }),
    ...(auth && { auth }),
  };
}

export function ApiClientPage() {
  const { app } = useCurrentApp();
  const envs = useEnvironments(app?.id);
  const tree = useTree(app?.id);
  const specs = useQuery({
    queryKey: ['api-specs', app?.id],
    queryFn: () => api<Spec[]>(`/api/applications/${app!.id}/api-specs`),
    enabled: !!app,
  });
  const [envId, setEnvId] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState<{ scenarioId: string; stepIndex: number; name: string } | null>(null);
  const [reqTab, setReqTab] = useState<'params' | 'headers' | 'body' | 'auth'>('params');
  const [resTab, setResTab] = useState<'body' | 'headers' | 'checks'>('body');
  const [result, setResult] = useState<SendResult | null>(null);
  const [importing, setImporting] = useState<{ specId?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (!envId && envs.data?.length) setEnvId((envs.data.find((e) => !e.isProduction) ?? envs.data[0]!).id);
  }, [envs.data, envId]);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const apiScenarios = useMemo(() => {
    if (!tree.data) return [];
    const modName = new Map(tree.data.modules.map((m) => [m.id, m.name]));
    return tree.data.scenarios
      .filter((s) => s.kind === 'api' || s.kind === 'hybrid')
      .map((s) => ({ ...s, module: modName.get(s.moduleId) ?? '' }));
  }, [tree.data]);

  const sendReq = useMutation({
    mutationFn: () => {
      let request;
      try {
        request = toRequest(draft);
      } catch {
        throw new Error('Body is not valid JSON');
      }
      return api<SendResult>('/api/api-client/send', {
        method: 'POST',
        json: { environmentId: envId, request },
      });
    },
    onSuccess: (r) => {
      setResult(r);
      if (r.response && r.contract && !r.contract.ok) setResTab('checks');
    },
    onError: toastError,
  });

  const openScenario = async (id: string) => {
    const s = await api<ScenarioDetail>(`/api/scenarios/${id}`);
    const i = s.steps.findIndex((x) => x.type === 'api.request');
    if (i < 0) return toast('This scenario has no API request step', 'error');
    setDraft(draftFromStep(s.steps[i]!));
    setLoaded({ scenarioId: s.id, stepIndex: i, name: s.name });
    setResult(null);
  };

  const updateStep = useMutation({
    mutationFn: async () => {
      const s = await api<ScenarioDetail>(`/api/scenarios/${loaded!.scenarioId}`);
      const steps = s.steps.map((st, i) =>
        i === loaded!.stepIndex ? { ...st, params: { ...st.params, ...toRequest(draft) } } : st,
      );
      return api(`/api/scenarios/${s.id}/steps`, { method: 'PUT', json: { steps } });
    },
    onSuccess: () => toast('Scenario step updated'),
    onError: toastError,
  });

  if (!app)
    return (
      <EmptyState
        icon={Webhook}
        title="No application selected"
        description="Create an application to send requests and build API tests."
      />
    );
  const res = result?.response;

  return (
    <>
      <PageHeader
        title="API Client"
        description="Send requests with environment variables and secrets, check the contract, and save them as API tests."
        actions={
          <Button variant="outline" onClick={() => setImporting({})}>
            <FileUp className="h-4 w-4" /> Import
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[280px_1fr]">
        <div className="space-y-4">
          <Card className="p-3">
            <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">API specs</p>
            {specs.isError && <ErrorState error={specs.error} onRetry={() => void specs.refetch()} />}
            {specs.data?.length === 0 && (
              <p className="text-xs text-muted">
                Import an OpenAPI spec to generate tests and check contracts.
              </p>
            )}
            <ul className="space-y-1">
              {specs.data?.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-fg/[0.04]"
                >
                  <FileJson className="h-4 w-4 text-indigo" />
                  <span className="min-w-0 flex-1 truncate">
                    {s.name}{' '}
                    <span className="text-xs text-muted">
                      v{s.version} · {s.parsedJson.operations.length} ops
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setImporting({ specId: s.id })}
                  >
                    Generate
                  </Button>
                  <button
                    aria-label={`Delete spec ${s.name}`}
                    className="text-muted hover:text-fail"
                    onClick={() =>
                      void api(`/api/api-specs/${s.id}`, { method: 'DELETE' }).then(() =>
                        qc.invalidateQueries({ queryKey: ['api-specs', app.id] }),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-3">
            <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">API scenarios</p>
            <ul className="max-h-[55vh] space-y-0.5 overflow-y-auto" aria-label="API scenarios">
              {apiScenarios.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => void openScenario(s.id)}
                    className={cn(
                      'w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-fg/[0.04]',
                      loaded?.scenarioId === s.id && 'bg-brand/10',
                    )}
                    title={`${s.module} / ${s.name}`}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
              {apiScenarios.length === 0 && <li className="text-xs text-muted">No API scenarios yet.</li>}
            </ul>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="p-4">
            {loaded && (
              <p className="mb-2 text-xs text-muted">
                Editing step of <span className="text-fg">{loaded.name}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Method"
                className={cn('w-28 font-mono font-semibold', METHOD_COLOR[draft.method])}
                value={draft.method}
                onChange={(e) => set({ method: e.target.value })}
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Input
                aria-label="Request URL"
                className="min-w-64 flex-1 font-mono text-sm"
                value={draft.url}
                onChange={(e) => set({ url: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) sendReq.mutate();
                }}
              />
              <Select
                aria-label="Environment"
                className="w-40"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
              >
                {envs.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
              <Button disabled={!envId || sendReq.isPending} onClick={() => sendReq.mutate()}>
                <Send className="h-4 w-4" /> {sendReq.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
            <Tabs
              className="mt-3 mb-3"
              value={reqTab}
              onChange={setReqTab}
              tabs={[
                { value: 'params', label: 'Params', count: draft.query.length || undefined },
                { value: 'headers', label: 'Headers', count: draft.headers.length || undefined },
                { value: 'body', label: 'Body' },
                { value: 'auth', label: 'Auth' },
              ]}
            />
            {reqTab === 'params' && (
              <KVEditor
                label="Query"
                rows={draft.query}
                onChange={(query) => set({ query })}
                keyPlaceholder="param"
              />
            )}
            {reqTab === 'headers' && (
              <KVEditor
                label="Headers"
                rows={draft.headers}
                onChange={(headers) => set({ headers })}
                keyPlaceholder="header"
              />
            )}
            {reqTab === 'body' && (
              <div className="space-y-2">
                <Select
                  aria-label="Body type"
                  className="w-40"
                  value={draft.bodyType}
                  onChange={(e) => set({ bodyType: e.target.value as Draft['bodyType'] })}
                >
                  <option value="none">No body</option>
                  <option value="json">JSON</option>
                  <option value="form">Form (a=1&b=2)</option>
                  <option value="raw">Raw text</option>
                </Select>
                {draft.bodyType !== 'none' && (
                  <CodeEditor
                    ariaLabel="Request body"
                    language={draft.bodyType === 'json' ? 'json' : 'plaintext'}
                    value={draft.body}
                    onChange={(body) => set({ body })}
                    height={180}
                  />
                )}
              </div>
            )}
            {reqTab === 'auth' && (
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Type">
                  <Select
                    aria-label="Auth type"
                    value={draft.auth.type}
                    onChange={(e) => set({ auth: { type: e.target.value as AuthType } })}
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="basic">Basic</option>
                    <option value="apiKey">API key</option>
                  </Select>
                </Field>
                {draft.auth.type === 'bearer' && (
                  <Field label="Token" className="md:col-span-2">
                    <Input
                      aria-label="Token"
                      className="font-mono"
                      placeholder="{{secret.apiToken}}"
                      value={draft.auth.token ?? ''}
                      onChange={(e) => set({ auth: { ...draft.auth, token: e.target.value } })}
                    />
                  </Field>
                )}
                {draft.auth.type === 'basic' && (
                  <>
                    <Field label="Username">
                      <Input
                        value={draft.auth.username ?? ''}
                        onChange={(e) => set({ auth: { ...draft.auth, username: e.target.value } })}
                      />
                    </Field>
                    <Field label="Password">
                      <Input
                        placeholder="{{secret.password}}"
                        value={draft.auth.password ?? ''}
                        onChange={(e) => set({ auth: { ...draft.auth, password: e.target.value } })}
                      />
                    </Field>
                  </>
                )}
                {draft.auth.type === 'apiKey' && (
                  <>
                    <Field label="Header name">
                      <Input
                        value={draft.auth.name ?? ''}
                        placeholder="x-api-key"
                        onChange={(e) => set({ auth: { ...draft.auth, name: e.target.value } })}
                      />
                    </Field>
                    <Field label="Value">
                      <Input
                        value={draft.auth.value ?? ''}
                        placeholder="{{secret.apiKey}}"
                        onChange={(e) => set({ auth: { ...draft.auth, value: e.target.value } })}
                      />
                    </Field>
                  </>
                )}
                <p className="text-xs text-muted md:col-span-3">
                  Use {'{{secret.name}}'} for credentials: they are resolved on the server and masked in every
                  response shown here.
                </p>
              </div>
            )}
          </Card>

          <Card className="p-4">
            {!result ? (
              <p className="py-8 text-center text-sm text-muted">Send a request to see the response.</p>
            ) : result.error ? (
              <div
                role="alert"
                className="rounded-lg border border-fail/30 bg-fail/5 p-3 font-mono text-xs text-fail"
              >
                {result.error.kind}: {result.error.message}
              </div>
            ) : (
              res && (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 font-mono font-semibold',
                        res.status < 300
                          ? 'bg-pass/12 text-pass'
                          : res.status < 500
                            ? 'bg-warn/15 text-warn'
                            : 'bg-fail/12 text-fail',
                      )}
                      data-testid="response-status"
                    >
                      {res.status} {res.statusText}
                    </span>
                    <span className="font-mono text-xs text-muted">{res.timeMs} ms</span>
                    <span className="font-mono text-xs text-muted">{res.size} B</span>
                    {result.contract && (
                      <Badge tone={result.contract.ok ? 'pass' : 'fail'} data-testid="contract-badge">
                        {result.contract.ok ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}{' '}
                        contract {result.contract.ok ? 'ok' : 'violated'}
                      </Badge>
                    )}
                    <div className="ml-auto flex gap-2">
                      {loaded && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={updateStep.isPending}
                          onClick={() => updateStep.mutate()}
                        >
                          Update scenario step
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setSaving(true)}>
                        <Save className="h-3.5 w-3.5" /> Save as API test
                      </Button>
                    </div>
                  </div>
                  <Tabs
                    className="mb-3"
                    value={resTab}
                    onChange={setResTab}
                    tabs={[
                      { value: 'body', label: 'Body' },
                      { value: 'headers', label: 'Headers', count: Object.keys(res.headers).length },
                      { value: 'checks', label: 'Contract' },
                    ]}
                  />
                  {resTab === 'body' && (
                    <pre
                      className="max-h-[420px] overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-5"
                      aria-label="Response body"
                    >
                      {typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2)}
                    </pre>
                  )}
                  {resTab === 'headers' && (
                    <table className="w-full font-mono text-xs">
                      <tbody>
                        {Object.entries(res.headers).map(([k, v]) => (
                          <tr key={k} className="border-b border-border">
                            <td className="py-1 pr-4 text-muted">{k}</td>
                            <td className="py-1 break-all">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {resTab === 'checks' &&
                    (result.contract ? (
                      <div className="space-y-1 text-sm">
                        <p className={result.contract.ok ? 'text-pass' : 'text-fail'}>
                          {result.contract.ok ? '✓ Response matches' : '✗ Response does not match'}{' '}
                          {result.contract.operation ?? 'the spec'}
                        </p>
                        {result.contract.errors.map((e) => (
                          <p key={e} className="font-mono text-xs text-fail">
                            • {e}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted">
                        Import an OpenAPI spec for this application to check responses against it.
                      </p>
                    ))}
                </>
              )
            )}
          </Card>
        </div>
      </div>
      {importing && (
        <ImportDialog applicationId={app.id} specId={importing.specId} onClose={() => setImporting(null)} />
      )}
      {saving && res && (
        <SaveDialog
          applicationId={app.id}
          defaultName={`${draft.method} ${(() => {
            try {
              return new URL(result!.request!.url).pathname;
            } catch {
              return draft.url;
            }
          })()}`}
          step={{
            type: 'api.request',
            params: toRequest(draft),
            locators: [],
            assertions: [
              { target: 'status', operator: 'equals', expected: res.status },
              { target: 'time', operator: 'lt', expected: Math.max(1000, res.timeMs * 3) },
            ],
            enabled: true,
            continueOnFail: false,
            retries: 0,
          }}
          onClose={() => setSaving(false)}
        />
      )}
    </>
  );
}

function SaveDialog({
  applicationId,
  defaultName,
  step,
  onClose,
}: {
  applicationId: string;
  defaultName: string;
  step: StepRecord;
  onClose: () => void;
}) {
  const tree = useTree(applicationId);
  const modules = tree.data ? flattenModules(tree.data) : [];
  const [moduleId, setModuleId] = useState('');
  const [name, setName] = useState(defaultName);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const target = moduleId || modules[0]?.id || '';
  const save = useMutation({
    mutationFn: () =>
      api<ScenarioDetail>(`/api/modules/${target}/scenarios`, {
        method: 'POST',
        json: { name, steps: [step] },
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.tree(applicationId) });
      toast('Saved as an API test');
      onClose();
      navigate({ to: '/explorer', search: { scenario: s.id } });
    },
    onError: toastError,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as API test"
      description="Creates a scenario with this request. Status and response-time assertions are added from the response."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!target || !name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input aria-label="Test name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Module">
          <Select aria-label="Save into module" value={target} onChange={(e) => setModuleId(e.target.value)}>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        {modules.length === 0 && (
          <p className="text-sm text-fail">Create a module in the Test Explorer first.</p>
        )}
      </div>
    </Dialog>
  );
}
