import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Layout } from '@/components/shell/layout';
import { NAV } from '@/lib/nav';
import { HomePage } from '@/pages/home';
import { PlaceholderPage } from '@/pages/placeholder';
import { SettingsPage } from '@/pages/settings';

const rootRoute = createRootRoute({ component: Layout });

const pages: Record<string, () => React.ReactNode> = {
  '/': HomePage,
  '/settings': SettingsPage,
};

const routes = NAV.map((item) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: item.to,
    component: pages[item.to] ?? (() => <PlaceholderPage item={item} />),
  }),
);

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultNotFoundComponent: () => <p className="text-sm text-muted">Page not found.</p>,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
