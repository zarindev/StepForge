import { PageHeader } from '@/components/shell/layout';
import { EmptyState } from '@/components/ui/states';
import type { NavItem } from '@/lib/nav';

/** Screens not yet delivered show what they will do and which build phase delivers them. */
export function PlaceholderPage({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <EmptyState
        icon={item.icon}
        title={`${item.label} is coming in Phase ${item.phase}`}
        description={`This screen is part of the StepForge roadmap. See docs/PROGRESS.md for the build status.`}
      />
    </>
  );
}
