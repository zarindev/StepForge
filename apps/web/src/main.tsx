import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Settings } from '@/lib/api';
import { live } from '@/lib/live';
import { applyCachedTheme, applyTheme } from '@/lib/theme';
import { router } from './router';
import './styles.css';

applyCachedTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } },
});

api<Settings>('/api/settings')
  .then((s) => applyTheme(s.theme))
  .catch(() => {
    /* the page-level error states explain connectivity problems */
  });
live.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
