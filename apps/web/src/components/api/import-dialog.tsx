import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FileUp, KeyRound, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useEnvironments } from '@/lib/queries';

type Kind = 'openapi' | 'postman' | 'curl' | 'har';
type Result = {
  rootModuleId: string;
  modules: number;
  scenarios: number;
  blocks: number;
  secretsNeeded: string[];
  warnings: string[];
};

/** Import OpenAPI / Postman / cURL / HAR into the current application's test tree. */
export function ImportDialog({
  applicationId,
  onClose,
  initialKind = 'openapi',
  specId,
}: {
  applicationId: string;
  onClose: () => void;
  initialKind?: Kind;
  specId?: string;
}) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('/openapi.json');
  const [source, setSource] = useState<'url' | 'text'>(specId ? 'url' : 'url');
  const envs = useEnvironments(applicationId);
  const [envId, setEnvId] = useState('');
  const [negative, setNegative] = useState(true);
  const [destructive, setDestructive] = useState(false);
  const [contract, setContract] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const env = envs.data?.find((e) => e.id === envId) ?? envs.data?.[0];

  const run = useMutation({
    mutationFn: async () => {
      if (kind === 'openapi') {
        let id = specId;
        if (!id) {
          const spec = await api<{ id: string }>(`/api/applications/${applicationId}/api-specs`, {
            method: 'POST',
            json: source === 'url' ? { url, environmentId: env?.id } : { content: text },
          });
          id = spec.id;
        }
        return api<Result>(`/api/applications/${applicationId}/import`, {
          method: 'POST',
          json: { kind, specId: id, options: { negative, destructive, contract } },
        });
      }
      let content: unknown = text;
      if (kind !== 'curl') {
        try {
          content = JSON.parse(text);
        } catch {
          throw new Error('The file is not valid JSON');
        }
      }
      return api<Result>(`/api/applications/${applicationId}/import`, {
        method: 'POST',
        json: { kind, content },
      });
    },
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: qk.tree(applicationId) });
      qc.invalidateQueries({ queryKey: ['api-specs', applicationId] });
      qc.invalidateQueries({ queryKey: ['blocks', applicationId] });
    },
    onError: toastError,
  });

  const readFile = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((t) => {
      setText(t);
      setSource('text');
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Import API tests"
      description="Generate scenarios from an API description, a collection, a cURL command or a browser HAR file."
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => {
                onClose();
                navigate({ to: '/explorer' });
              }}
            >
              Open in Test Explorer
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                run.isPending ||
                (kind !== 'openapi' && !text.trim()) ||
                (kind === 'openapi' && !specId && source === 'text' && !text.trim())
              }
              onClick={() => run.mutate()}
            >
              <FileUp className="h-4 w-4" /> {run.isPending ? 'Importing…' : 'Import'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm" role="status">
          <p className="text-base font-medium text-pass">
            Created {result.scenarios} scenario(s) in {result.modules} module(s)
            {result.blocks ? ` and ${result.blocks} block(s)` : ''}.
          </p>
          {result.secretsNeeded.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3">
              <KeyRound className="mt-0.5 h-4 w-4 text-warn" />
              <span>
                Set these secrets on the application’s Secrets tab before running:{' '}
                {result.secretsNeeded.map((s) => (
                  <code key={s} className="mx-1">
                    {s}
                  </code>
                ))}
              </span>
            </div>
          )}
          {result.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-muted">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-warn" /> {w}
            </p>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {!specId && (
            <Tabs
              value={kind}
              onChange={(k) => {
                setKind(k);
                setText('');
              }}
              tabs={[
                { value: 'openapi', label: 'OpenAPI / Swagger' },
                { value: 'postman', label: 'Postman' },
                { value: 'curl', label: 'cURL' },
                { value: 'har', label: 'HAR' },
              ]}
            />
          )}
          {kind === 'openapi' && !specId && (
            <>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="accent-[#F97316]"
                    checked={source === 'url'}
                    onChange={() => setSource('url')}
                  />{' '}
                  From URL
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="accent-[#F97316]"
                    checked={source === 'text'}
                    onChange={() => setSource('text')}
                  />{' '}
                  Paste or upload
                </label>
              </div>
              {source === 'url' ? (
                <div className="grid grid-cols-3 gap-3">
                  <Field
                    label="Spec URL"
                    className="col-span-2"
                    hint={env ? `Relative paths resolve against ${env.baseUrl}` : undefined}
                  >
                    <Input
                      aria-label="Spec URL"
                      className="font-mono"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="/openapi.json or https://…"
                    />
                  </Field>
                  <Field label="Environment">
                    <Select
                      aria-label="Import environment"
                      value={env?.id ?? ''}
                      onChange={(e) => setEnvId(e.target.value)}
                    >
                      {envs.data?.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              ) : null}
            </>
          )}
          {(kind !== 'openapi' || (!specId && source === 'text')) && (
            <>
              <Textarea
                aria-label="Import content"
                rows={10}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={
                  kind === 'curl'
                    ? "curl 'https://api.example.com/items' -H 'Accept: application/json'"
                    : kind === 'openapi'
                      ? 'Paste OpenAPI JSON or YAML'
                      : 'Paste the file content, or upload it below'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {kind !== 'curl' && (
                <input
                  type="file"
                  aria-label="Upload file"
                  accept={
                    kind === 'har'
                      ? '.har,application/json'
                      : kind === 'postman'
                        ? '.json'
                        : '.json,.yaml,.yml'
                  }
                  className="text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-fg/10 file:px-3 file:py-1.5 file:text-fg"
                  onChange={(e) => readFile(e.target.files?.[0])}
                />
              )}
            </>
          )}
          {kind === 'openapi' && (
            <div className="flex flex-wrap gap-5 border-t border-border pt-3 text-sm">
              <label className="flex items-center gap-2">
                <Switch checked={negative} onChange={setNegative} label="Negative tests" /> Negative tests
                (missing field, wrong type, invalid enum, unauthorized, not found)
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={contract} onChange={setContract} label="Contract checks" /> Contract check on
                every request
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={destructive} onChange={setDestructive} label="Destructive tests" /> Include
                DELETE happy paths (destroys data)
              </label>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
