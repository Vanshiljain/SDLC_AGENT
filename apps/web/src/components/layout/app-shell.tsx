import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Bell, Building2, Check, ChevronsUpDown, LogOut, Menu as MenuIcon, Moon, PanelRightOpen, Search, Sparkles, Sun, UserRound, X } from 'lucide-react';
import { useApprovals, useNotifications, useUnreadCount } from '@/api/queries';
import { api } from '@/api/client';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/api/queries';
import { cn } from '@/lib/cn';
import { useAuth, useRealtimeStatus } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { ui, useUi } from '@/lib/ui-store';
import { Button } from '@/components/ui/button';
import { Avatar, Kbd } from '@/components/ui/primitives';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, Tooltip } from '@/components/ui/menu';
import { CommandPalette } from '@/features/command-palette';
import { AssistantPanel } from '@/features/assistant/assistant-panel';
import { LogoMark } from './logo';
import { NAV } from './nav';

export function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);
  const assistantOpen = useUi((s) => s.assistantOpen);
  const location = useLocation();

  useEffect(() => setMobileNav(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.set({ paletteOpen: !ui.get().paletteOpen });
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        ui.set({ assistantOpen: !ui.get().assistantOpen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar className="hidden lg:flex" />
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNav(false)} />
          <Sidebar className="relative z-10 flex h-full shadow-pop" onClose={() => setMobileNav(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />
        <Topbar onMenu={() => setMobileNav(true)} />
        <div className="flex min-h-0 flex-1">
          <main id="main" className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
          {assistantOpen && <AssistantPanel />}
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}

function Sidebar({ className, onClose }: { className?: string; onClose?: () => void }) {
  const approvals = useApprovals({ status: 'PENDING', pageSize: 1 });
  const pending = approvals.data?.total ?? 0;
  return (
    <aside className={cn('w-[232px] shrink-0 flex-col border-r border-line bg-surface', className)}>
      <div className="flex h-12 items-center justify-between px-3.5">
        <NavLink to="/dashboard" className="flex items-center gap-2 rounded-md">
          <LogoMark className="size-6" />
          <span className="text-[14.5px] font-semibold tracking-[-0.02em]">Forgeline</span>
        </NavLink>
        {onClose && <Button size="icon-sm" variant="ghost" aria-label="Close navigation" onClick={onClose} icon={<X className="size-4" />} />}
      </div>
      <OrgSwitcher />
      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-4" aria-label="Main">
        {NAV.map((group) => (
          <div key={group.section} className="mt-4 first:mt-2">
            <div className="label-caps px-2 pb-1">{group.section}</div>
            <ul className="space-y-px">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors',
                        isActive ? 'bg-sunken font-medium text-fg' : 'text-fg-muted hover:bg-sunken/60 hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" />}
                        <item.icon className={cn('size-4 shrink-0', isActive ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted')} />
                        <span className="truncate">{item.label}</span>
                        {item.badge === 'approvals' && pending > 0 && <span className="ml-auto rounded-sm bg-accent px-1.5 font-mono text-[10.5px] leading-[18px] font-semibold text-accent-fg">{pending}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={() => ui.set({ assistantOpen: true })}
          className="group flex w-full items-center gap-2.5 rounded-md border border-line bg-raised px-2.5 py-2 text-left transition-colors hover:border-ai/40"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-ai-soft text-ai">
            <Sparkles className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-medium">Ask Forge</span>
            <span className="block truncate text-[11px] text-fg-subtle">Plan, build, ship</span>
          </span>
          <Kbd>⌘J</Kbd>
        </button>
      </div>
    </aside>
  );
}

function OrgSwitcher() {
  const { organization, memberships, switchOrganization } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="px-2">
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="flex w-full items-center gap-2 rounded-md border border-line bg-raised px-2 py-1.5 text-left hover:border-line-strong">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-sunken text-[11px] font-semibold text-fg-muted">{organization?.organizationName.slice(0, 1) ?? '?'}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{organization?.organizationName ?? 'Select workspace'}</span>
              <span className="block text-[10.5px] text-fg-subtle">{organization?.isDemo ? 'Demo · simulated' : organization ? organization.role.toLowerCase() : ''}</span>
            </span>
            <ChevronsUpDown className="size-3.5 text-fg-subtle" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-60">
          <MenuLabel>Workspaces</MenuLabel>
          {memberships.map((m) => (
            <MenuItem
              key={m.organizationId}
              icon={<Building2 />}
              onSelect={() => {
                switchOrganization(m.organizationId);
                navigate('/dashboard');
              }}
            >
              <span className="flex-1 truncate">{m.organizationName}</span>
              {m.isDemo && <span className="text-[10px] font-semibold text-warn uppercase">Demo</span>}
              {m.organizationId === organization?.organizationId && <Check className="size-3.5 text-accent" />}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

function DemoBanner() {
  const { organization } = useAuth();
  if (!organization?.isDemo) return null;
  return (
    <div className="demo-stripes flex items-center justify-center gap-2 border-b border-warn/30 px-4 py-1.5 text-center text-[12px] text-warn">
      <span className="font-semibold">Demo workspace</span>
      <span className="text-warn/80 sm:hidden">All runs are simulated.</span>
      <span className="hidden text-warn/80 sm:inline">Every run here is simulated and labelled as such — no tickets, PRs or deployments are created in real systems.</span>
    </div>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const live = useRealtimeStatus();
  const navigate = useNavigate();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface/80 px-3 backdrop-blur sm:px-4">
      <Button size="icon-sm" variant="ghost" className="lg:hidden" aria-label="Open navigation" onClick={onMenu} icon={<MenuIcon className="size-4" />} />
      <button
        type="button"
        onClick={() => ui.set({ paletteOpen: true })}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-sunken/60 px-2.5 text-[12.5px] text-fg-subtle transition-colors hover:border-line-strong hover:text-fg-muted sm:max-w-md"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">
          <span className="sm:hidden">Search or ask…</span>
          <span className="hidden sm:inline">Search, run a command, or ask Forge…</span>
        </span>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <Tooltip content={live ? 'Live updates connected' : 'Reconnecting to live updates…'}>
          <span className="mr-1 hidden items-center gap-1.5 rounded-sm px-1.5 text-[11px] text-fg-subtle sm:flex">
            <span className={cn('size-1.5 rounded-full', live ? 'animate-pulse-dot bg-ok text-ok' : 'bg-warn')} />
            {live ? 'Live' : 'Offline'}
          </span>
        </Tooltip>
        <Notifications />
        <Tooltip content="Assistant (⌘J)">
          <Button size="icon-sm" variant="ghost" aria-label="Toggle assistant" onClick={() => ui.set({ assistantOpen: !ui.get().assistantOpen })} icon={<PanelRightOpen className="size-4" />} />
        </Tooltip>
        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
          <Button size="icon-sm" variant="ghost" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} icon={theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />} />
        </Tooltip>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="ml-1 rounded-full" aria-label="Account menu">
              <Avatar name={user?.name} size={26} />
            </button>
          </MenuTrigger>
          <MenuContent>
            <div className="px-2 py-1.5">
              <div className="text-[13px] font-medium">{user?.name}</div>
              <div className="text-[11.5px] text-fg-subtle">{user?.email}</div>
            </div>
            <MenuSeparator />
            <MenuItem icon={<UserRound />} onSelect={() => navigate('/settings?tab=profile')}>
              Profile
            </MenuItem>
            <MenuItem icon={<LogOut />} onSelect={() => void logout().then(() => navigate('/login'))}>
              Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

function Notifications() {
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const count = unread.data?.count ?? 0;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[360px]"
      trigger={
        <button type="button" aria-label={`Notifications${count ? ` (${count} unread)` : ''}`} className="relative flex size-7 items-center justify-center rounded-sm text-fg-muted hover:bg-sunken hover:text-fg">
          <Bell className="size-4" />
          {count > 0 && <span className="absolute top-0.5 right-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-[14px] font-bold text-accent-fg">{count > 9 ? '9+' : count}</span>}
        </button>
      }
    >
      {open && <NotificationList onNavigate={() => setOpen(false)} />}
    </Popover>
  );
}

function NotificationList({ onNavigate }: { onNavigate: () => void }) {
  const { data, isLoading } = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const markAll = async () => {
    await api.post('/notifications/read', {});
    void qc.invalidateQueries({ queryKey: qk.notifications });
  };
  const items = data ?? [];
  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[13px] font-semibold">Notifications</span>
        <Button size="xs" variant="ghost" onClick={() => void markAll()}>
          Mark all read
        </Button>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {isLoading && <div className="p-4 text-[12px] text-fg-subtle">Loading…</div>}
        {!isLoading && !items.length && <div className="p-6 text-center text-[12.5px] text-fg-subtle">You’re all caught up.</div>}
        {items.map((n) => (
          <NotificationRow
            key={n.id}
            title={n.title}
            body={n.body}
            unread={!n.readAt}
            at={n.createdAt}
            onClick={() => {
              const link = n.link ? n.link.replace(/^https?:\/\/[^/]+/, '') : null;
              if (!n.readAt) void api.post('/notifications/read', { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: qk.notifications }));
              if (link) navigate(link);
              onNavigate();
            }}
          />
        ))}
      </div>
    </div>
  );
}

function NotificationRow({ title, body, unread, at, onClick }: { title: string; body: string | null; unread: boolean; at: string; onClick: () => void }): ReactNode {
  return (
    <button type="button" onClick={onClick} className="flex w-full gap-2.5 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-sunken">
      <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', unread ? 'bg-accent' : 'bg-transparent')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{title}</span>
        {body && <span className="mt-0.5 line-clamp-2 block text-[12px] text-fg-muted">{body}</span>}
        <span className="mt-1 block text-[11px] text-fg-subtle">{timeAgo(at)}</span>
      </span>
    </button>
  );
}
