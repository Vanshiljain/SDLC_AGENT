import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Play } from 'lucide-react';
import { api } from '@/api/client';
import { qk, useAction, useCommands, useProjects } from '@/api/queries';
import type { CommandDef, ExecutionDetail } from '@/api/types';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Badge } from '@/components/ui/primitives';

/** Launches any catalog command with a typed input form; the server validates and enforces permissions. */
let pending: { id: string; prefill: Record<string, unknown> } | null = null;
const listeners = new Set<() => void>();
export const commandLauncher = {
  open(id: string, prefill: Record<string, unknown> = {}) {
    pending = { id, prefill };
    listeners.forEach((l) => l());
  },
  close() {
    pending = null;
    listeners.forEach((l) => l());
  },
};

export function CommandDialogHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  if (!current) return null;
  return <CommandLoader key={current.id} id={current.id} prefill={current.prefill} />;
}

function CommandLoader({ id, prefill }: { id: string; prefill: Record<string, unknown> }) {
  const { data } = useCommands();
  const command = data?.commands.find((c) => c.id === id);
  if (!command) return null;
  return <CommandDialog command={command} prefill={prefill} onClose={() => commandLauncher.close()} />;
}

function CommandDialog({ command, prefill, onClose }: { command: CommandDef; prefill: Record<string, unknown>; onClose: () => void }) {
  const navigate = useNavigate();
  const { organization } = useAuth();
  const projects = useProjects();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...prefill }));
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!values.projectId && projects.data?.length === 1) set('projectId', projects.data[0]!.id);
  }, [projects.data, values.projectId]);

  const project = projects.data?.find((p) => p.id === values.projectId);
  const missing = command.inputs.filter((i) => i.required && (values[i.name] === undefined || values[i.name] === ''));

  const run = useAction(
    async () => {
      const { projectId, ...inputs } = values;
      for (const i of command.inputs) if (i.type === 'pull_request' && inputs[i.name] !== undefined) inputs[i.name] = Number(inputs[i.name]);
      return api.post<ExecutionDetail>(`/commands/${command.id}/execute`, { projectId: projectId || undefined, inputs, source: 'COMMAND_PALETTE' });
    },
    {
      success: (e) => (e.mode === 'DEMO' ? `Started (simulated): ${e.title}` : `Started: ${e.title}`),
      invalidate: [['executions', 'list'], qk.dashboard],
      onSuccess: (e) => {
        onClose();
        navigate(`/executions/${e.id}`);
      },
    },
  );

  const envOptions = useMemo(() => project?.environments ?? [], [project]);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={command.title}
      description={command.description}
      footer={
        <>
          {organization?.isDemo && <Badge tone="warn">Demo — will be simulated</Badge>}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Play className="size-3.5" />} loading={run.isPending} disabled={missing.length > 0} onClick={() => run.mutate(undefined)}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing.length) run.mutate(undefined);
        }}
      >
        {command.inputs.map((input) => {
          const v = values[input.name];
          switch (input.type) {
            case 'project':
              return (
                <Field key={input.name} label={input.label} required={input.required}>
                  <Select value={String(v ?? '')} onChange={(e) => set(input.name, e.target.value)}>
                    <option value="">Select a project…</option>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            case 'environment':
              return (
                <Field key={input.name} label={input.label} required={input.required} hint={!project ? 'Select a project first' : undefined}>
                  <Select value={String(v ?? '')} onChange={(e) => set(input.name, e.target.value)} disabled={!project}>
                    <option value="">Select an environment…</option>
                    {envOptions.map((env) => (
                      <option key={env.id} value={env.name}>
                        {env.name} · {env.type.toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            case 'text':
              return (
                <Field key={input.name} label={input.label} required={input.required}>
                  <Textarea value={String(v ?? '')} placeholder={input.placeholder} onChange={(e) => set(input.name, e.target.value)} rows={4} />
                </Field>
              );
            case 'boolean':
              return (
                <div key={input.name} className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-fg-muted">{input.label}</span>
                  <Switch checked={Boolean(v)} onCheckedChange={(c) => set(input.name, c)} label={input.label} />
                </div>
              );
            case 'pull_request':
            case 'number':
              return (
                <Field key={input.name} label={input.label} required={input.required}>
                  <Input type="number" min={1} value={v === undefined ? '' : String(v)} placeholder={input.placeholder} onChange={(e) => set(input.name, e.target.value === '' ? undefined : e.target.value)} />
                </Field>
              );
            default:
              return (
                <Field key={input.name} label={input.label} required={input.required}>
                  <Input value={String(v ?? '')} placeholder={input.placeholder} onChange={(e) => set(input.name, e.target.value)} />
                </Field>
              );
          }
        })}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
