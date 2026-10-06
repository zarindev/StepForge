import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useTree } from '@/lib/queries';

type Option = { id: string; label: string };
type Ctx = { applicationId: string; scenarios: Option[]; blocks: Option[]; selfId?: string };
const EditorCtx = createContext<Ctx>({ applicationId: '', scenarios: [], blocks: [] });

/** Provides scenario/block choices to callScenario / useBlock fields. */
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
      api<{ id: string; name: string; stepCount: number }[]>(`/api/applications/${applicationId}/blocks`),
  });
  const value: Ctx = {
    applicationId,
    selfId,
    scenarios: (tree.data?.scenarios ?? [])
      .filter((s) => s.id !== selfId)
      .map((s) => ({ id: s.id, label: s.name })),
    blocks: (blocks.data ?? []).map((b) => ({ id: b.id, label: `${b.name} (${b.stepCount} steps)` })),
  };
  return <EditorCtx.Provider value={value}>{children}</EditorCtx.Provider>;
}

export const useEditorCtx = () => useContext(EditorCtx);
