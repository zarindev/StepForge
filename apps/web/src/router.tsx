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
import { PerformancePage } from '@/pages/performance';
import { BugsPage } from '@/pages/bugs';
import { AnalyticsPage } from '@/pages/analytics';
import { ComparePage } from '@/pages/compare';
import { SchedulesPage } from '@/pages/schedules';
import { ExportsPage } from '@/pages/exports';

const rootRoute = createRootRoute({ component: Layout });

const pages: Record<string, () => React.ReactNode> = {
  '/': HomePage,
  '/runs': RunsPage,
  '/api-client': ApiClientPage,
  '/settings': SettingsPage,
  '/performance': PerformancePage,
  '/schedules': SchedulesPage,
};

/** Started from the Test Explorer: record into this scenario, or save the new scenario into this module. */
const RecorderSearch = z.object({ scenario: z.string().optional(), module: z.string().optional() });

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
  navRoute('/api-client'),
  navRoute('/performance'),
  navRoute('/runs'),
  navRoute('/schedules'),
  navRoute('/settings'),
];

const recorderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recorder',
  validateSearch: (s) => RecorderSearch.parse(s),
  component: RecorderPage,
});

const sqlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sql',
  validateSearch: (s) => z.object({ connection: z.string().optional() }).parse(s),
  component: SqlWorkbenchPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/applications/$appId/analytics',
  component: AnalyticsPage,
});

const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/compare',
  validateSearch: (s) => z.object({ base: z.string().optional(), head: z.string().optional() }).parse(s),
  component: ComparePage,
});

const applicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/applications',
  /** `new` opens the create dialog (first-run onboarding). */
  validateSearch: (s) => z.object({ new: z.boolean().optional() }).parse(s),
  component: ApplicationsPage,
});

const exportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/exports',
  /** `scenario` preselects one scenario (Explorer → Export code). */
  validateSearch: (s) => z.object({ scenario: z.string().optional() }).parse(s),
  component: ExportsPage,
});

const bugsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bugs',
  validateSearch: (s) => z.object({ bug: z.string().optional() }).parse(s),
  component: BugsPage,
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
  /** `item` opens one test's results directly (drill-down from analytics and bugs). */
  validateSearch: (s) => z.object({ item: z.string().optional() }).parse(s),
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
    recorderRoute,
    sqlRoute,
    applicationsRoute,
    exportsRoute,
    bugsRoute,
    analyticsRoute,
    compareRoute,
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
