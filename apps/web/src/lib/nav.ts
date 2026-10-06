import {
  AppWindow,
  Bug,
  CalendarClock,
  Database,
  Disc3,
  FolderTree,
  Gauge,
  Home,
  type LucideIcon,
  PackageOpen,
  PlayCircle,
  Settings,
  Webhook,
} from 'lucide-react';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  description: string;
  /** Build phase that delivers this screen (shown in empty states until then). */
  phase: number;
};

export const NAV: NavItem[] = [
  {
    to: '/',
    label: 'Home',
    icon: Home,
    shortcut: 'G H',
    description: 'Quality overview across all applications',
    phase: 10,
  },
  {
    to: '/applications',
    label: 'Applications',
    icon: AppWindow,
    shortcut: 'G A',
    description: 'Applications under test, environments, secrets and connections',
    phase: 2,
  },
  {
    to: '/explorer',
    label: 'Test Explorer',
    icon: FolderTree,
    shortcut: 'G E',
    description: 'Modules, scenarios and test cases',
    phase: 2,
  },
  {
    to: '/recorder',
    label: 'Recorder',
    icon: Disc3,
    shortcut: 'G R',
    description: 'Record scenarios by clicking through your app',
    phase: 4,
  },
  {
    to: '/api-client',
    label: 'API Client',
    icon: Webhook,
    description: 'Send requests, import OpenAPI/Postman/HAR, build API tests',
    phase: 5,
  },
  {
    to: '/sql',
    label: 'SQL Workbench',
    icon: Database,
    description: 'Query databases, audit data quality, save DB tests',
    phase: 6,
  },
  {
    to: '/performance',
    label: 'Performance',
    icon: Gauge,
    description: 'Page metrics, Lighthouse and load testing',
    phase: 8,
  },
  {
    to: '/runs',
    label: 'Runs',
    icon: PlayCircle,
    shortcut: 'G U',
    description: 'Live and past test runs with evidence',
    phase: 3,
  },
  {
    to: '/bugs',
    label: 'Bugs',
    icon: Bug,
    shortcut: 'G B',
    description: 'Auto-generated bug reports with diagnosis',
    phase: 9,
  },
  {
    to: '/schedules',
    label: 'Schedules',
    icon: CalendarClock,
    description: 'Scheduled runs and notifications',
    phase: 11,
  },
  {
    to: '/exports',
    label: 'Exports',
    icon: PackageOpen,
    description: 'Export to Playwright, Cypress, Selenium, k6 and docs',
    phase: 12,
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: Settings,
    shortcut: 'G S',
    description: 'Preferences, integrations and data',
    phase: 1,
  },
];
