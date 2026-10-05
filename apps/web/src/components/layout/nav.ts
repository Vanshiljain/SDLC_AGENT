import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BookOpenText,
  Bot,
  CheckCheck,
  FileText,
  FolderKanban,
  GitPullRequestArrow,
  Hand,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Network,
  Plug,
  Rocket,
  ScrollText,
  Settings,
  Workflow,
  Zap,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'approvals';
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Deliver',
    items: [
      { to: '/dashboard', label: 'Command Center', icon: LayoutDashboard },
      { to: '/chat', label: 'Assistant', icon: MessageSquareText },
      { to: '/executions', label: 'Runs', icon: Zap },
      { to: '/approvals', label: 'Approvals', icon: Hand, badge: 'approvals' },
      { to: '/deployments', label: 'Deployments', icon: Rocket },
    ],
  },
  {
    section: 'Build',
    items: [
      { to: '/workflows', label: 'Flows', icon: Workflow },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/tasks', label: 'Tasks', icon: ListChecks },
      { to: '/code-reviews', label: 'Code reviews', icon: GitPullRequestArrow },
      { to: '/qa', label: 'Quality', icon: CheckCheck },
      { to: '/documents', label: 'Docs', icon: FileText },
    ],
  },
  {
    section: 'Understand',
    items: [
      { to: '/graph', label: 'Engineering Graph', icon: Network },
      { to: '/knowledge', label: 'Knowledge', icon: BookOpenText },
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/observability', label: 'Observability', icon: Activity },
      { to: '/audit-logs', label: 'Audit log', icon: ScrollText },
    ],
  },
  {
    section: 'Configure',
    items: [
      { to: '/integrations', label: 'Integrations', icon: Plug },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];
