import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { api } from './api';
import { useCurrentAppId, setCurrentAppId } from './current-app';
import { useLiveEvent, type LiveEvent } from './live';
import type {
  Application,
  Environment,
  ScenarioDetail,
  ScenarioVersion,
  SecretMeta,
  Tag,
  Tree,
} from './types';

export const qk = {
  applications: ['applications'] as const,
  application: (id: string) => ['applications', id] as const,
  environments: (appId: string) => ['environments', appId] as const,
  secrets: (envId: string) => ['secrets', envId] as const,
  tags: (appId: string) => ['tags', appId] as const,
  tree: (appId: string) => ['tree', appId] as const,
  scenario: (id: string) => ['scenario', id] as const,
  versions: (id: string) => ['versions', id] as const,
};

export const useApplications = () =>
  useQuery({ queryKey: qk.applications, queryFn: () => api<Application[]>('/api/applications') });

export const useApplication = (id: string | null | undefined) =>
  useQuery({
    queryKey: qk.application(id ?? ''),
    queryFn: () => api<Application>(`/api/applications/${id}`),
    enabled: !!id,
  });

export const useEnvironments = (appId: string | null | undefined) =>
  useQuery({
    queryKey: qk.environments(appId ?? ''),
    queryFn: () => api<Environment[]>(`/api/applications/${appId}/environments`),
    enabled: !!appId,
  });

export const useSecrets = (envId: string | null | undefined) =>
  useQuery({
    queryKey: qk.secrets(envId ?? ''),
    queryFn: () => api<SecretMeta[]>(`/api/environments/${envId}/secrets`),
    enabled: !!envId,
  });

export const useTags = (appId: string | null | undefined) =>
  useQuery({
    queryKey: qk.tags(appId ?? ''),
    queryFn: () => api<Tag[]>(`/api/applications/${appId}/tags`),
    enabled: !!appId,
  });

export const useTree = (appId: string | null | undefined) =>
  useQuery({
    queryKey: qk.tree(appId ?? ''),
    queryFn: () => api<Tree>(`/api/applications/${appId}/tree`),
    enabled: !!appId,
  });

export const useScenario = (id: string | null | undefined) =>
  useQuery({
    queryKey: qk.scenario(id ?? ''),
    queryFn: () => api<ScenarioDetail>(`/api/scenarios/${id}`),
    enabled: !!id,
  });

export const useVersions = (id: string | null | undefined) =>
  useQuery({
    queryKey: qk.versions(id ?? ''),
    queryFn: () => api<ScenarioVersion[]>(`/api/scenarios/${id}/versions`),
    enabled: !!id,
  });

/** Resolves the selected application, falling back to the first one when nothing (valid) is selected. */
export function useCurrentApp() {
  const id = useCurrentAppId();
  const apps = useApplications();
  const list = apps.data ?? [];
  const app = list.find((a) => a.id === id) ?? list[0] ?? null;
  useEffect(() => {
    if (apps.isSuccess && app?.id !== id) setCurrentAppId(app?.id ?? null);
  }, [apps.isSuccess, app?.id, id]);
  return { app, apps };
}

/** Keeps cached data fresh when another tab (or the CLI later) changes the tree. */
export function useLiveInvalidation(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (e: LiveEvent) => {
      if (e.type === 'tree.changed' && typeof e.applicationId === 'string') {
        qc.invalidateQueries({ queryKey: qk.tree(e.applicationId) });
        qc.invalidateQueries({ queryKey: qk.tags(e.applicationId) });
        qc.invalidateQueries({ queryKey: qk.applications });
        qc.invalidateQueries({ queryKey: ['scenario'] });
        qc.invalidateQueries({ queryKey: ['versions'] });
      }
    },
    [qc],
  );
  useLiveEvent(handler);
}
