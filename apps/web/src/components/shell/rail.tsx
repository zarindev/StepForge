import { Link, useRouterState } from '@tanstack/react-router';
import { NAV } from '@/lib/nav';
import { cn } from '@/lib/utils';

export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Main"
      className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3"
    >
      <Link to="/" aria-label="StepForge home" className="mb-3 grid h-10 w-10 place-items-center">
        <img src="/logo.svg" alt="" className="h-8 w-8 drop-shadow-[0_0_12px_rgb(249_115_22/0.45)]" />
      </Link>
      {NAV.map((item) => {
        const active =
          item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
        const last = item.to === '/settings';
        return (
          <Link
            key={item.to}
            to={item.to}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative grid h-10 w-10 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5 hover:text-fg',
              active && 'bg-brand/12 text-brand hover:bg-brand/15 hover:text-brand',
              last && 'mt-auto',
            )}
          >
            {active && <span className="absolute -left-3 h-5 w-1 rounded-r bg-brand" />}
            <item.icon className="h-[18px] w-[18px]" />
            <span className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-md border border-border bg-elevated px-2 py-1 text-xs text-fg opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
