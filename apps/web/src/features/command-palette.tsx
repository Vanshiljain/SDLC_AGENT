import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Command } from 'cmdk';
import * as D from '@radix-ui/react-dialog';
import { ArrowRight, CornerDownLeft, FolderKanban, Moon, Play, Sparkles, Wand2, Zap } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { useCommands, useExecutions, useProjects } from '@/api/queries';
import type { CommandRoute } from '@/api/types';
import { cn } from '@/lib/cn';
import { setTheme } from '@/lib/theme';
import { ui, useUi } from '@/lib/ui-store';
import { Kbd, Spinner } from '@/components/ui/primitives';
import { StatusDot } from '@/components/ui/status';
import { NAV } from '@/components/layout/nav';
import { commandLauncher } from './run-command';
import { toast } from 'sonner';

/**
 * ⌘K — navigate anywhere, run any command, or hand the request to Forge.
 * "Route with AI" asks the server to map free text to a command, page or chat.
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const [search, setSearch] = useState('');
  const [routing, setRouting] = useState(false);
  const navigate = useNavigate();
  const commands = useCommands();
  const projects = useProjects();
  const runs = useExecutions({ pageSize: 6 });

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const close = () => ui.set({ paletteOpen: false });
  const go = (to: string) => {
    close();
    navigate(to);
  };

  const route = async () => {
    const q = search.trim();
    if (q.length < 2) return;
    setRouting(true);
    try {
      const r = await api.post<CommandRoute>('/commands/route', { query: q, pageContext: ui.get().pageContext ?? undefined });
      close();
      if (r.kind === 'navigate' && r.route) navigate(r.route);
      else if (r.kind === 'command' && r.commandId) {
        const prefill = Object.fromEntries(r.inputs.map((i) => [i.name, i.value]));
        commandLauncher.open(r.commandId, { ...(r.projectId && { projectId: r.projectId }), ...prefill });
      } else ui.ask(q);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRouting(false);
    }
  };

  const pages = NAV.flatMap((g) => g.items);
  const q = search.trim();

  return (
    <D.Root open={open} onOpenChange={(o) => ui.set({ paletteOpen: o })}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-raised shadow-pop data-[state=open]:animate-fade-in"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command
            label="Command palette"
            loop
            className="[&_[cmdk-group-heading]]:label-caps [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Sparkles className="size-4 text-ai" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                autoFocus
                placeholder="Type a command, search, or describe what you need…"
                className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-subtle"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void route();
                  }
                }}
              />
              {routing ? <Spinner className="size-3.5 text-fg-subtle" /> : <Kbd>esc</Kbd>}
            </div>
            <Command.List className="max-h-[min(440px,60vh)] overflow-y-auto pb-2">
              <Command.Empty className="px-4 py-8 text-center text-[12.5px] text-fg-subtle">
                No matches. Press Enter on “Ask Forge” to hand it to the assistant.
              </Command.Empty>

              {q.length > 1 && (
                <Command.Group heading="Forge">
                  <Item value={`ask ${q}`} icon={<Sparkles className="text-ai" />} onSelect={() => ui.ask(q)} hint={<Kbd>↵</Kbd>}>
                    Ask Forge: <span className="text-fg">“{q}”</span>
                  </Item>
                  <Item value={`route ${q}`} icon={<Wand2 />} onSelect={() => void route()} hint={<Kbd>⌘↵</Kbd>}>
                    Find the right action for “{q}”
                  </Item>
                </Command.Group>
              )}

              <Command.Group heading="Commands">
                {commands.data?.commands.map((c) => (
                  <Item
                    key={c.id}
                    value={`${c.title} ${c.keywords.join(' ')} ${c.category}`}
                    icon={<Play />}
                    onSelect={() => (close(), commandLauncher.open(c.id))}
                    hint={<span className="text-[11px] text-fg-subtle">{c.category}</span>}
                  >
                    {c.title}
                  </Item>
                ))}
              </Command.Group>

              {!!runs.data?.items.length && (
                <Command.Group heading="Recent runs">
                  {runs.data.items.map((r) => (
                    <Item
                      key={r.id}
                      value={`run ${r.title} ${r.id}`}
                      icon={<Zap />}
                      onSelect={() => go(`/executions/${r.id}`)}
                      hint={<StatusDot status={r.status} />}
                    >
                      <span className="truncate">{r.title}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              {!!projects.data?.length && (
                <Command.Group heading="Projects">
                  {projects.data.map((p) => (
                    <Item
                      key={p.id}
                      value={`project ${p.name} ${p.key}`}
                      icon={<FolderKanban />}
                      onSelect={() => go(`/projects/${p.id}`)}
                      hint={<span className="font-mono text-[11px] text-fg-subtle">{p.key}</span>}
                    >
                      {p.name}
                    </Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Go to">
                {pages.map((p) => (
                  <Item
                    key={p.to}
                    value={`go ${p.label}`}
                    icon={<p.icon />}
                    onSelect={() => go(p.to)}
                    hint={<ArrowRight className="size-3 text-fg-subtle" />}
                  >
                    {p.label}
                  </Item>
                ))}
                <Item value="new flow builder" icon={<Wand2 />} onSelect={() => go('/workflows/new')}>
                  New flow
                </Item>
              </Command.Group>

              <Command.Group heading="Preferences">
                <Item value="theme dark mode" icon={<Moon />} onSelect={() => (setTheme('dark'), close())}>
                  Dark mode
                </Item>
                <Item value="theme light mode" icon={<Moon />} onSelect={() => (setTheme('light'), close())}>
                  Light mode
                </Item>
              </Command.Group>
            </Command.List>
            <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-fg-subtle">
              <span className="flex items-center gap-1">
                <CornerDownLeft className="size-3" /> select
              </span>
              <span className="flex items-center gap-1">
                <Kbd>⌘↵</Kbd> route with AI
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Kbd>⌘J</Kbd> assistant
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Item({
  children,
  icon,
  onSelect,
  value,
  hint,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onSelect: () => void;
  value: string;
  hint?: React.ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        'mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg-muted outline-none',
        'data-[selected=true]:bg-sunken data-[selected=true]:text-fg',
      )}
    >
      <span className="text-fg-subtle [&>svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">{children}</span>
      {hint}
    </Command.Item>
  );
}
