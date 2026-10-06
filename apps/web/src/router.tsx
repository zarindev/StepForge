import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { z } from 'zod';
import { Layout } from '@/components/shell/layout';
import { NAV } from '@/lib/nav';
import { ApiClientPage } from '@/pages/api-client';
import { ApplicationDetailPage } from '@/pages/application-detail';
import { ApplicationsPage } from '@/pages/applications';
import { ExplorerPage } from '@/pages/explorer';
import { RunDetailPage } from '@/pages/run-detail';
import { RunsPage } from '@/pages/runs';
import { HomePage } from '@/pages/home';
import { PlaceholderPage } from '@/pages/placeholder';
import { RecorderPage } from '@/pages/recorder';
import { SettingsPage } from '@/pages/settings';
import { SqlWorkbenchPage } from '@/pages/sql-workbench';

const rootRoute = createRootRoute({ component: Layout });

const pages: Record<string, () => React.ReactNode> = {
  '/': HomePage,
  '/applications': ApplicationsPage,
  '/runs': RunsPage,
  '/recorder': RecorderPage,
  '/api-client': ApiClientPage,
  '/settings': SettingsPage,
};

const ExplorerSearch = z.object({
  scenario: z.string().optional(),
  tab: z.enum(['steps', 'testCases', 'overview', 'history']).optional(),
});

/** Keeps each path as a literal type so links are type-checked. */
function navRoute<P extends string>(path: P) {
  const item = NAV.find((n) => n.to === path)!;
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: pages[path] ?? (() => <PlaceholderPage item={item} />),
  });
}

const navRoutes = [
  navRoute('/'),
  navRoute('/applications'),
  navRoute('/recorder'),
  navRoute('/api-client'),
  navRoute('/performance'),
  navRoute('/runs'),
  navRoute('/bugs'),
  navRoute('/schedules'),
  navRoute('/exports'),
  navRoute('/settings'),
];

const sqlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sql',
  validateSearch: (s) => z.object({ connection: z.string().optional() }).parse(s),
  component: SqlWorkbenchPage,
});

const explorerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explorer',
  validateSearch: (s) => ExplorerSearch.parse(s),
  component: ExplorerPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  component: RunDetailPage,
});

const applicationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/applications/$appId',
  component: ApplicationDetailPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    ...navRoutes,
    sqlRoute,
    explorerRoute,
    applicationDetailRoute,
    runDetailRoute,
  ]),
  defaultNotFoundComponent: () => <p className="text-sm text-muted">Page not found.</p>,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
