import type { Locator } from '@stepforge/core';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useConnections, useInboxes, useTree } from '@/lib/queries';

type Option = { id: string; label: string };
/** A saved element of the application (the element repository). */
export type ElementOption = {
  id: string;
  name: string;
  page: string;
  description: string;
  locatorsJson: Locator[];
  usedBy: number;
  usedBySteps: number;
};
export type BlockOption = Option & {
  name: string;
  usedBy: number;
  inputs: { name: string; default?: string; description?: string }[];
};
type Ctx = {
  applicationId: string;
  scenarios: Option[];
  blocks: BlockOption[];
  elements: ElementOption[];
  /** Test data library sources (steps refer to them by name). */
  dataSources: { name: string; kind: string; columns: string[] }[];
  /** Database connection names (steps refer to connections by name, per environment). */
  connections: Option[];
  /** Email inbox names of the application. */
  inboxes: Option[];
  selfId?: string;
};
const EditorCtx = createContext<Ctx>({
  applicationId: '',
  scenarios: [],
  blocks: [],
  elements: [],
  dataSources: [],
  connections: [],
  inboxes: [],
});

/** Provides scenario/block/connection choices to callScenario / useBlock / db.* fields. */
export function EditorProvider({
  applicationId,
  selfId,
  children,
}: {
  applicationId: string;
  selfId?: string;
  children: ReactNode;
}) {
  const tree = useTree(applicationId);
  const blocks = useQuery({
    queryKey: ['blocks', applicationId],
    queryFn: () =>
      api<
        {
          id: string;
          name: string;
          stepCount: number;
          usedBy: number;
          inputsJson: BlockOption['inputs'];
        }[]
      >(`/api/applications/${applicationId}/blocks`),
  });
  const elements = useQuery({
    queryKey: ['elements', applicationId],
    queryFn: () => api<ElementOption[]>(`/api/applications/${applicationId}/elements`),
    enabled: !!applicationId,
  });
  const dataSources = useQuery({
    queryKey: ['data-sources', applicationId],
    queryFn: () =>
      api<{ name: string; kind: string; columnsJson: string[] }[]>(
        `/api/applications/${applicationId}/data-sources`,
      ),
    enabled: !!applicationId,
  });
  const conns = useConnections(applicationId);
  const inboxes = useInboxes(applicationId);
  const byName = new Map<string, string[]>();
  for (const c of conns.data ?? []) byName.set(c.name, [...(byName.get(c.name) ?? []), c.environmentName]);
  const value: Ctx = {
    applicationId,
    selfId,
    scenarios: (tree.data?.scenarios ?? [])
      .filter((s) => s.id !== selfId)
      .map((s) => ({ id: s.id, label: s.name })),
    blocks: (blocks.data ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      label: `${b.name} (${b.stepCount} steps)`,
      usedBy: b.usedBy,
      inputs: b.inputsJson ?? [],
    })),
    elements: elements.data ?? [],
    dataSources: (dataSources.data ?? []).map((d) => ({
      name: d.name,
      kind: d.kind,
      columns: d.columnsJson,
    })),
    connections: [...byName].map(([name, envs]) => ({ id: name, label: `${name} (${envs.join(', ')})` })),
    inboxes: (inboxes.data ?? []).map((i) => ({
      id: i.name,
      label: `${i.name} (${i.kind === 'mailpit' ? 'Mailpit' : 'IMAP'})`,
    })),
  };
  return <EditorCtx.Provider value={value}>{children}</EditorCtx.Provider>;
}

export const useEditorCtx = () => useContext(EditorCtx);

/**
 * For display only: element references show their element. `forSummary` names the element (step list rows);
 * otherwise the element's own locators are used, so plain-English sentences read naturally.
 */
export function withElements<T extends { locators?: Locator[]; params?: Record<string, unknown> }>(
  steps: T[],
  elements: ElementOption[],
  forSummary = false,
): T[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return steps.map((s) => {
    const params = { ...(s.params ?? {}) };
    for (const key of ['steps', 'else'])
      if (Array.isArray(params[key])) params[key] = withElements(params[key] as T[], elements, forSummary);
    return {
      ...s,
      params,
      // Nested steps (inside conditions and loops) may have no locators at all.
      locators: (s.locators ?? []).flatMap((l) => {
        if (l.strategy !== 'element') return [l];
        const e = byId.get(l.value);
        if (!e) return [{ ...l, name: 'deleted element' }];
        return forSummary ? [{ ...l, name: e.name }] : e.locatorsJson;
      }),
    };
  });
}
