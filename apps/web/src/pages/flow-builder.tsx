import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import {
  ArrowLeft,
  CalendarClock,
  Check,
  CircleAlert,
  Clock,
  Hand,
  LayoutGrid,
  Play,
  Plus,
  Save,
  Search,
  Split,
  Trash2,
  Webhook,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { STEP_KEY_PATTERN, type StepDefinition, type WorkflowDefinition } from '@forgeline/shared';
import { api, errorMessage } from '@/api/client';
import { qk, useAction, useProjects, useTools, useWorkflow } from '@/api/queries';
import type { ToolInfo, ValidationIssue, Workflow, WorkflowTrigger } from '@/api/types';
import { cn } from '@/lib/cn';
import { titleCase } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Badge, Mono, Skeleton } from '@/components/ui/primitives';
import { Tooltip } from '@/components/ui/menu';
import { Segmented } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { AGENTS, agentOf, layout, NODE_H, NODE_W, nodeTypes, type StepNodeData } from '@/features/flow-graph';
import { ancestors, uniqueKey, wouldCycle } from '@/features/flow-utils';

// ─────────────── Draft hand-off (from "Describe a flow" / template preview) ───────────────
interface BuilderDraft {
  name: string;
  description?: string;
  definition: WorkflowDefinition | null;
  trigger?: Record<string, unknown>;
  issues?: { path: string; message: string }[];
  projectId?: string | null;
  readOnly?: boolean;
}
let pendingDraft: BuilderDraft | null = null;
export function setBuilderDraft(d: BuilderDraft) {
  pendingDraft = d;
}

const EMPTY: WorkflowDefinition = { version: 1, inputs: {}, variables: {}, steps: [], onFailure: 'fail', concurrency: 8 };

function newStep(partial: Partial<StepDefinition> & Pick<StepDefinition, 'key' | 'name'>): StepDefinition {
  return { type: 'tool', input: {}, dependsOn: [], runIf: 'all_success', continueOnError: false, ...partial };
}

export function FlowBuilderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const existing = useWorkflow(id ?? '', Boolean(id));
  const tools = useTools();
  const projects = useProjects();

  const [name, setName] = useState('Untitled flow');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [def, setDef] = useState<WorkflowDefinition>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<Record<string, unknown> | null>(null);
  const [dialog, setDialog] = useState<null | 'inputs' | 'trigger' | 'run'>(null);
  const loaded = useRef(false);

  useDocumentTitle(name);
  usePageContext(id ? { title: name, entity: { kind: 'workflow', id, label: name } } : { title: 'Flow builder' }, [id, name]);

  // Load once: existing flow, or a hand-off draft, or a blank canvas.
  useEffect(() => {
    if (loaded.current) return;
    if (id) {
      if (!existing.data) return;
      const wf = existing.data;
      setName(wf.name);
      setDescription(wf.description ?? '');
      setProjectId(wf.projectId);
      setDef(withPositions(wf.definition));
      setReadOnly(wf.isBuiltIn || !can('workflow:manage'));
      loaded.current = true;
      return;
    }
    const draft = params.get('draft') || params.get('preview') ? pendingDraft : null;
    pendingDraft = null;
    if (draft) {
      setName(draft.name);
      setDescription(draft.description ?? '');
      setProjectId(draft.projectId ?? null);
      if (draft.definition) setDef(withPositions(draft.definition));
      if (draft.issues?.length) setIssues(draft.issues.map((i) => ({ path: i.path, message: i.message })));
      if (draft.trigger && draft.trigger.type !== 'MANUAL') setPendingTrigger(draft.trigger);
      setReadOnly(Boolean(draft.readOnly));
      setDirty(!draft.readOnly);
    }
    loaded.current = true;
  }, [id, existing.data, params, can]);

  const update = useCallback((fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    setDef((d) => fn(d));
    setDirty(true);
    setIssues(null);
  }, []);

  const updateStep = useCallback(
    (key: string, patch: Partial<StepDefinition>) => {
      update((d) => {
        let steps = d.steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
        if (patch.key && patch.key !== key) {
          const nk = patch.key;
          steps = steps.map((s) => ({
            ...s,
            dependsOn: s.dependsOn.map((x) => (x === key ? nk : x)),
            ...(s.repair?.step === key && { repair: { ...s.repair, step: nk } }),
          }));
        }
        return { ...d, steps };
      });
      if (patch.key && patch.key !== key) setSelected(patch.key);
    },
    [update],
  );

  const addStep = (step: StepDefinition) => {
    if (readOnly) return;
    const sel = def.steps.find((s) => s.key === selected);
    const x = sel?.ui ? sel.ui.x + NODE_W + 60 : 40 + (def.steps.length % 5) * 40;
    const y = sel?.ui ? sel.ui.y : 40 + def.steps.length * 24;
    const s = { ...step, dependsOn: sel ? [sel.key] : [], ui: { x, y } };
    update((d) => ({ ...d, steps: [...d.steps, s] }));
    setSelected(s.key);
  };

  const removeStep = (key: string) => {
    update((d) => ({
      ...d,
      steps: d.steps
        .filter((s) => s.key !== key)
        .map((s) => {
          const next = { ...s, dependsOn: s.dependsOn.filter((x) => x !== key) };
          if (next.repair?.step === key) delete next.repair;
          return next;
        }),
    }));
    setSelected(null);
  };

  const autoLayout = () => {
    const nodes = def.steps.map((s) => ({ id: s.key, position: { x: 0, y: 0 }, data: {} }));
    const edges = def.steps.flatMap((s) => s.dependsOn.map((d) => ({ id: `${d}-${s.key}`, source: d, target: s.key })));
    const laid = layout(nodes, edges, 'LR');
    const pos = new Map(laid.map((n) => [n.id, n.position]));
    update((d) => ({
      ...d,
      steps: d.steps.map((s) => ({ ...s, ui: { ...(s.ui ?? {}), x: Math.round(pos.get(s.key)!.x), y: Math.round(pos.get(s.key)!.y) } })),
    }));
  };

  // ─────────────── Graph projection ───────────────
  const invalidKeys = useMemo(
    () =>
      new Set(
        (issues ?? [])
          .map((i) => i.stepKey ?? i.path.match(/^steps\.(\d+)/)?.[1])
          .filter(Boolean)
          .map((k) => (/^\d+$/.test(k!) ? def.steps[Number(k)]?.key : k)),
      ),
    [issues, def.steps],
  );
  const toolAgent = useMemo(() => new Map((tools.data ?? []).map((t) => [t.name, t.agent ?? undefined])), [tools.data]);
  const nodes: Node<StepNodeData>[] = useMemo(
    () =>
      def.steps.map((s) => ({
        id: s.key,
        type: 'step',
        position: { x: s.ui?.x ?? 0, y: s.ui?.y ?? 0 },
        width: NODE_W,
        height: NODE_H,
        selected: s.key === selected,
        draggable: !readOnly,
        data: {
          step: s.agent || !s.tool ? s : { ...s, agent: toolAgent.get(s.tool) },
          invalid: invalidKeys.has(s.key),
          repairOf: def.steps.find((o) => o.repair?.step === s.key)?.key ?? null,
        },
      })),
    [def.steps, selected, invalidKeys, readOnly, toolAgent],
  );
  const edges: Edge[] = useMemo(
    () => [
      ...def.steps.flatMap((s) =>
        s.dependsOn.map((d) => ({
          id: `${d}->${s.key}`,
          source: d,
          target: s.key,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          deletable: !readOnly,
        })),
      ),
      ...def.steps
        .filter((s) => s.repair)
        .map((s) => ({
          id: `${s.key}~>${s.repair!.step}`,
          source: s.key,
          target: s.repair!.step,
          deletable: false,
          selectable: false,
          label: 'repair',
          style: { strokeDasharray: '4 4', stroke: 'var(--color-ai)' },
          labelStyle: { fill: 'var(--color-ai)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--color-canvas)' },
        })),
    ],
    [def.steps, readOnly],
  );

  const onNodesChange = (changes: NodeChange<Node<StepNodeData>>[]) => {
    const moves = changes.filter((c) => c.type === 'position' && c.position);
    if (moves.length && !readOnly) {
      setDef((d) => ({
        ...d,
        steps: d.steps.map((s) => {
          const m = moves.find((c) => c.type === 'position' && c.id === s.key);
          return m && m.type === 'position' && m.position
            ? { ...s, ui: { ...(s.ui ?? {}), x: Math.round(m.position.x), y: Math.round(m.position.y) } }
            : s;
        }),
      }));
      setDirty(true);
    }
    for (const c of changes) if (c.type === 'remove' && !readOnly) removeStep(c.id);
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (readOnly) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (!removed.length) return;
    update((d) => ({
      ...d,
      steps: d.steps.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((dep) => !removed.includes(`${dep}->${s.key}`)) })),
    }));
  };
  const onConnect = (c: Connection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    if (wouldCycle(def.steps, c.source, c.target)) return void toast.error('That connection would create a cycle');
    update((d) => ({
      ...d,
      steps: d.steps.map((s) =>
        s.key === c.target && !s.dependsOn.includes(c.source!) ? { ...s, dependsOn: [...s.dependsOn, c.source!] } : s,
      ),
    }));
  };

  // ─────────────── Server actions ───────────────
  const validate = useAction(() => api.post<{ valid: boolean; issues: ValidationIssue[] }>('/workflows/validate', { definition: def }), {
    onSuccess: (r) => {
      setIssues(r.issues);
      if (r.valid) toast.success('Flow is valid');
    },
  });
  const save = useAction(
    async () => {
      const body = { name, description: description || undefined, projectId: projectId ?? undefined, definition: def };
      const wf = id ? await api.patch<Workflow>(`/workflows/${id}`, body) : await api.post<Workflow>('/workflows', body);
      if (pendingTrigger) {
        await api.post(`/workflows/${wf.id}/triggers`, { config: pendingTrigger, enabled: true });
        setPendingTrigger(null);
      }
      return wf;
    },
    {
      success: 'Flow saved',
      invalidate: [qk.workflows],
      onSuccess: (wf) => {
        setDirty(false);
        void existing.refetch();
        if (!id) navigate(`/workflows/${wf.id}`, { replace: true });
      },
      silent: true,
    },
  );
  useEffect(() => {
    if (save.error) {
      const body = (save.error as { body?: { details?: unknown } }).body;
      if (Array.isArray(body?.details)) setIssues((body.details as ValidationIssue[]).filter((d) => typeof d === 'object'));
      toast.error(errorMessage(save.error));
    }
  }, [save.error]);

  const steps = def.steps;
  const selectedStep = steps.find((s) => s.key === selected) ?? null;

  if (id && existing.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-[70vh]" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Link to="/workflows" className="rounded-sm p-1 text-fg-muted hover:bg-sunken hover:text-fg" aria-label="Back to flows">
          <ArrowLeft className="size-4" />
        </Link>
        <input
          value={name}
          onChange={(e) => (setName(e.target.value), setDirty(true))}
          disabled={readOnly}
          aria-label="Flow name"
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[15px] font-semibold tracking-tight outline-none hover:bg-sunken focus:bg-sunken sm:max-w-sm"
        />
        {readOnly && <Badge tone="warn">Read-only</Badge>}
        {existing.data && <Badge>v{existing.data.version}</Badge>}
        {dirty && !readOnly && <span className="text-[11.5px] text-fg-subtle">Unsaved changes</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select
            value={projectId ?? ''}
            onChange={(e) => (setProjectId(e.target.value || null), setDirty(true))}
            disabled={readOnly}
            className="h-7 w-44 text-[12px]"
            aria-label="Project"
          >
            <option value="">No project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setDialog('inputs')}>
            Inputs{Object.keys(def.inputs).length ? ` (${Object.keys(def.inputs).length})` : ''}
          </Button>
          <Button size="sm" variant="ghost" icon={<Zap className="size-3.5" />} onClick={() => setDialog('trigger')} disabled={readOnly}>
            Trigger
          </Button>
          <Tooltip content="Auto-arrange">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Auto-arrange"
              onClick={autoLayout}
              disabled={readOnly || !steps.length}
              icon={<LayoutGrid className="size-4" />}
            />
          </Tooltip>
          <Button
            size="sm"
            icon={<Check className="size-3.5" />}
            loading={validate.isPending}
            onClick={() => validate.mutate(undefined)}
            disabled={!steps.length}
          >
            Validate
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              variant={id ? 'secondary' : 'primary'}
              icon={<Save className="size-3.5" />}
              loading={save.isPending}
              disabled={!steps.length || name.trim().length < 2}
              onClick={() => save.mutate(undefined)}
            >
              Save
            </Button>
          )}
          {id && (
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={dirty} onClick={() => setDialog('run')}>
              Run
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {!readOnly && <Palette tools={tools.data ?? []} loading={tools.isLoading} onAdd={addStep} steps={steps} />}
        <div className="relative min-w-0 flex-1">
          <div className="grid-dots h-full">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(null)}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.15}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { strokeWidth: 1.3 } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="transparent" />
              <Controls position="bottom-right" showInteractive={false} />
            </ReactFlow>
          </div>
          {!steps.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto max-w-sm rounded-xl border border-dashed border-line-strong bg-surface/90 p-6 text-center backdrop-blur">
                <div className="text-[14px] font-semibold">Start your flow</div>
                <p className="mt-1.5 text-[12.5px] text-fg-muted">
                  Add steps from the palette on the left. Connect them by dragging from one step’s right edge to another. Steps run as soon
                  as their dependencies finish.
                </p>
              </div>
            </div>
          )}
          {issues && issues.length > 0 && (
            <div className="absolute bottom-3 left-3 max-h-48 w-[min(520px,calc(100%-24px))] overflow-y-auto rounded-lg border border-bad/40 bg-raised p-3 shadow-pop">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-bad">
                <CircleAlert className="size-3.5" /> {issues.length} issue{issues.length === 1 ? '' : 's'} to fix
                <button
                  type="button"
                  className="ml-auto text-fg-subtle hover:text-fg"
                  onClick={() => setIssues(null)}
                  aria-label="Dismiss issues"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <ul className="space-y-1 text-[12px]">
                {issues.map((i, n) => (
                  <li key={n}>
                    <button type="button" className="text-left hover:underline" onClick={() => i.stepKey && setSelected(i.stepKey)}>
                      <Mono className="text-fg-muted">{i.stepKey ?? i.path}</Mono> — {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pendingTrigger && (
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-md border border-arc/40 bg-raised px-3 py-1.5 text-[12px] shadow-card">
              <Webhook className="size-3.5 text-arc" /> Trigger will be added on save:{' '}
              <Mono>{String(pendingTrigger.event ?? pendingTrigger.cron)}</Mono>
            </div>
          )}
        </div>
        {selectedStep && (
          <Inspector
            key={selectedStep.key}
            step={selectedStep}
            steps={steps}
            def={def}
            tools={tools.data ?? []}
            readOnly={readOnly}
            onChange={(p) => updateStep(selectedStep.key, p)}
            onRemove={() => removeStep(selectedStep.key)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      <InputsDialog
        open={dialog === 'inputs'}
        def={def}
        readOnly={readOnly}
        onClose={() => setDialog(null)}
        onChange={(inputs) => update((d) => ({ ...d, inputs }))}
      />
      <TriggerDialog
        open={dialog === 'trigger'}
        workflow={existing.data ?? null}
        onClose={() => setDialog(null)}
        onPending={setPendingTrigger}
        onChanged={() => void existing.refetch()}
      />
      {id && existing.data && <RunDialog open={dialog === 'run'} workflow={existing.data} onClose={() => setDialog(null)} />}
    </div>
  );
}

function withPositions(def: WorkflowDefinition): WorkflowDefinition {
  if (def.steps.every((s) => s.ui)) return def;
  const nodes = def.steps.map((s) => ({ id: s.key, position: { x: 0, y: 0 }, data: {} }));
  const edges = def.steps.flatMap((s) => s.dependsOn.map((d) => ({ id: `${d}-${s.key}`, source: d, target: s.key })));
  for (const s of def.steps) if (s.repair) edges.push({ id: `r-${s.key}`, source: s.key, target: s.repair.step });
  const pos = new Map(layout(nodes, edges, 'LR').map((n) => [n.id, n.position]));
  return {
    ...def,
    steps: def.steps.map((s) => (s.ui ? s : { ...s, ui: { x: Math.round(pos.get(s.key)!.x), y: Math.round(pos.get(s.key)!.y) } })),
  };
}

// ─────────────── Palette ───────────────
function Palette({
  tools,
  loading,
  onAdd,
  steps,
}: {
  tools: ToolInfo[];
  loading: boolean;
  onAdd: (s: StepDefinition) => void;
  steps: StepDefinition[];
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const filtered = tools.filter((t) => !q || `${t.title} ${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()));
    const map = new Map<string, ToolInfo[]>();
    for (const t of filtered) map.set(t.category, [...(map.get(t.category) ?? []), t]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, q]);
  const special: { label: string; icon: React.ReactNode; make: () => StepDefinition }[] = [
    {
      label: 'Approval gate',
      icon: <Hand className="size-3.5 text-accent" />,
      make: () =>
        newStep({ key: uniqueKey('approval', steps), name: 'Approval', type: 'approval', approval: { title: 'Approve to continue' } }),
    },
    {
      label: 'Condition',
      icon: <Split className="size-3.5" />,
      make: () => newStep({ key: uniqueKey('condition', steps), name: 'Condition', type: 'condition', expression: 'true' }),
    },
    {
      label: 'Delay',
      icon: <Clock className="size-3.5" />,
      make: () => newStep({ key: uniqueKey('wait', steps), name: 'Wait', type: 'delay', delayMs: 60_000 }),
    },
  ];
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line p-2.5">
        <Input icon={<Search className="size-3.5" />} placeholder="Search tools…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="label-caps px-1.5 pt-1 pb-1.5">Control</div>
        {special.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onAdd(s.make())}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-sunken"
          >
            {s.icon}
            {s.label}
            <Plus className="ml-auto size-3 text-fg-subtle" />
          </button>
        ))}
        {loading && <Skeleton className="mt-3 h-40" />}
        {groups.map(([cat, list]) => (
          <div key={cat} className="mt-3">
            <div className="label-caps px-1.5 pb-1.5">{titleCase(cat)}</div>
            {list.map((t) => {
              const a = agentOf({ agent: t.agent, tool: t.name });
              return (
                <Tooltip key={t.name} content={t.description} side="right">
                  <button
                    type="button"
                    onClick={() =>
                      onAdd(
                        newStep({
                          key: uniqueKey(t.name.split('.').pop() ?? t.name, steps),
                          name: t.title,
                          tool: t.name,
                          agent: t.agent ?? undefined,
                          input: defaultInput(t),
                        }),
                      )
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-sunken"
                  >
                    <a.icon className="size-3.5 shrink-0" style={{ color: a.color }} />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.approvalAction && <Hand className="size-3 shrink-0 text-accent" />}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

function defaultInput(t: ToolInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of t.inputSchema.required ?? []) {
    const p = t.inputSchema.properties?.[name];
    out[name] =
      p?.default ?? (p?.type === 'number' || p?.type === 'integer' ? 0 : p?.type === 'boolean' ? false : p?.type === 'array' ? [] : '');
  }
  return out;
}

// ─────────────── Inspector ───────────────
function Inspector({
  step,
  steps,
  def,
  tools,
  readOnly,
  onChange,
  onRemove,
  onClose,
}: {
  step: StepDefinition;
  steps: StepDefinition[];
  def: WorkflowDefinition;
  tools: ToolInfo[];
  readOnly: boolean;
  onChange: (p: Partial<StepDefinition>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const tool = tools.find((t) => t.name === step.tool);
  const [inputText, setInputText] = useState(() => JSON.stringify(step.input ?? {}, null, 2));
  const [inputError, setInputError] = useState<string | null>(null);
  const [key, setKey] = useState(step.key);
  const refs = useMemo(
    () => ['inputs.' + (Object.keys(def.inputs)[0] ?? 'name'), ...ancestors(steps, step.key).map((k) => `steps.${k}.output`)],
    [def.inputs, steps, step.key],
  );
  const a = agentOf(step);
  const commitInput = (text: string) => {
    setInputText(text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Input must be a JSON object');
      setInputError(null);
      onChange({ input: parsed as Record<string, unknown> });
    } catch (err) {
      setInputError((err as Error).message);
    }
  };
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <a.icon className="size-4" style={{ color: a.color }} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{step.name}</span>
        {!readOnly && (
          <Button
            size="icon-sm"
            variant="danger-ghost"
            aria-label="Delete step"
            onClick={onRemove}
            icon={<Trash2 className="size-3.5" />}
          />
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Close inspector" onClick={onClose} icon={<X className="size-4" />} />
      </div>
      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="Name">
          <Input value={step.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field
          label="Key"
          hint="Used in templates: steps.<key>.output"
          error={STEP_KEY_PATTERN.test(key) ? null : 'snake_case, starting with a letter'}
        >
          <Input
            value={key}
            className="font-mono text-[12px]"
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => key !== step.key && STEP_KEY_PATTERN.test(key) && !steps.some((s) => s.key === key) && onChange({ key })}
          />
        </Field>
        {step.type === 'tool' && (
          <>
            <Field label="Tool">
              <Select value={step.tool ?? ''} onChange={(e) => onChange({ tool: e.target.value })}>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.title} · {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            {tool && (
              <div className="rounded-md bg-sunken px-3 py-2 text-[11.5px] text-fg-muted">
                {tool.description}
                {tool.approvalAction && (
                  <div className="mt-1.5 flex items-center gap-1 text-accent">
                    <Hand className="size-3" /> Gated by policy: <Mono className="text-accent">{tool.approvalAction}</Mono>
                  </div>
                )}
              </div>
            )}
            <Field
              label="Input (JSON)"
              error={inputError}
              hint={
                <span>
                  Use templates like <Mono>{'{{ ' + (refs[1] ?? refs[0]) + ' }}'}</Mono>
                </span>
              }
            >
              <Textarea
                value={inputText}
                onChange={(e) => commitInput(e.target.value)}
                rows={8}
                className="font-mono text-[11.5px]"
                spellCheck={false}
              />
            </Field>
            {tool?.inputSchema.properties && (
              <div className="space-y-1 text-[11.5px]">
                <div className="label-caps">Parameters</div>
                {Object.entries(tool.inputSchema.properties).map(([p, spec]) => (
                  <div key={p} className="flex gap-2">
                    <Mono className={cn('shrink-0', tool.inputSchema.required?.includes(p) ? 'text-fg' : '')}>
                      {p}
                      {tool.inputSchema.required?.includes(p) ? '*' : ''}
                    </Mono>
                    <span className="truncate text-fg-subtle">
                      {spec.description ?? (Array.isArray(spec.type) ? spec.type.join('|') : spec.type)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Field label="Agent persona">
              <Select value={step.agent ?? ''} onChange={(e) => onChange({ agent: e.target.value || undefined })}>
                <option value="">Default</option>
                {Object.entries(AGENTS)
                  .filter(([k]) => k !== 'orchestrator')
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        )}
        {step.type === 'approval' && (
          <>
            <Field label="Approval title">
              <Input
                value={step.approval?.title ?? ''}
                onChange={(e) => onChange({ approval: { ...(step.approval ?? { title: '' }), title: e.target.value } })}
              />
            </Field>
            <Field label="Policy action" hint="e.g. deploy.production, pr.merge — drives required permission and risk">
              <Input
                value={step.approval?.action ?? ''}
                className="font-mono text-[12px]"
                onChange={(e) =>
                  onChange({ approval: { ...(step.approval ?? { title: 'Approval' }), action: e.target.value || undefined } })
                }
              />
            </Field>
          </>
        )}
        {step.type === 'condition' && (
          <Field label="Expression" hint="Result is available as steps.<key>.output.result">
            <Input
              value={step.expression ?? ''}
              className="font-mono text-[12px]"
              onChange={(e) => onChange({ expression: e.target.value })}
            />
          </Field>
        )}
        {step.type === 'delay' && (
          <Field label="Delay (seconds)">
            <Input
              type="number"
              min={0}
              value={Math.round((step.delayMs ?? 0) / 1000)}
              onChange={(e) => onChange({ delayMs: Math.max(0, Number(e.target.value)) * 1000 })}
            />
          </Field>
        )}

        <div className="space-y-3 border-t border-line pt-4">
          <div className="label-caps">Control flow</div>
          <Field label="Run only when" hint="Expression; when false the step is skipped">
            <Input
              value={step.when ?? ''}
              placeholder="inputs.deployToProduction == true"
              className="font-mono text-[12px]"
              onChange={(e) => onChange({ when: e.target.value || undefined })}
            />
          </Field>
          <Field label="Run policy">
            <Select value={step.runIf} onChange={(e) => onChange({ runIf: e.target.value as StepDefinition['runIf'] })}>
              <option value="all_success">All dependencies succeeded</option>
              <option value="none_failed">No dependency failed (skips are fine)</option>
              <option value="always">Always (after dependencies finish)</option>
            </Select>
          </Field>
          {step.type === 'tool' && (
            <>
              <Field label="Success condition" hint="Evaluated against the output; false fails the step">
                <Input
                  value={step.successCondition ?? ''}
                  placeholder="output.passed == true"
                  className="font-mono text-[12px]"
                  onChange={(e) => onChange({ successCondition: e.target.value || undefined })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max attempts">
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={step.retry?.maxAttempts ?? 3}
                    onChange={(e) =>
                      onChange({ retry: { ...(step.retry ?? {}), maxAttempts: Math.min(10, Math.max(1, Number(e.target.value))) } })
                    }
                  />
                </Field>
                <Field label="Self-heal with">
                  <Select
                    value={step.repair?.step ?? ''}
                    onChange={(e) =>
                      onChange({
                        repair: e.target.value ? { step: e.target.value, maxIterations: step.repair?.maxIterations ?? 2 } : undefined,
                      })
                    }
                  >
                    <option value="">No repair</option>
                    {steps
                      .filter((s) => s.key !== step.key)
                      .map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            </>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-fg-muted">Continue on error</span>
            <Switch checked={step.continueOnError} onCheckedChange={(v) => onChange({ continueOnError: v })} label="Continue on error" />
          </div>
          <div className="text-[11.5px] text-fg-subtle">
            Depends on:{' '}
            {step.dependsOn.length
              ? step.dependsOn.map((d) => (
                  <Mono key={d} className="mr-1">
                    {d}
                  </Mono>
                ))
              : 'nothing (starts immediately)'}
          </div>
        </div>
      </fieldset>
    </aside>
  );
}

// ─────────────── Inputs ───────────────
function InputsDialog({
  open,
  def,
  readOnly,
  onClose,
  onChange,
}: {
  open: boolean;
  def: WorkflowDefinition;
  readOnly: boolean;
  onClose: () => void;
  onChange: (inputs: WorkflowDefinition['inputs']) => void;
}) {
  const [rows, setRows] = useState(() => Object.entries(def.inputs));
  useEffect(() => {
    if (open) setRows(Object.entries(def.inputs));
  }, [open, def.inputs]);
  const set = (i: number, patch: Partial<WorkflowDefinition['inputs'][string]> & { name?: string }) =>
    setRows((r) =>
      r.map(([n, spec], idx) =>
        idx === i ? [patch.name ?? n, { ...spec, ...patch, name: undefined } as WorkflowDefinition['inputs'][string]] : [n, spec],
      ),
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Flow inputs"
      description="Values provided when the flow starts. Reference them in steps as {{ inputs.<name> }}."
      wide
      footer={
        !readOnly && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onChange(
                  Object.fromEntries(
                    rows
                      .filter(([n]) => /^[a-zA-Z_]\w*$/.test(n))
                      .map(([n, s]) => [n, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as typeof s]),
                  ),
                );
                onClose();
              }}
            >
              Apply
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="space-y-2">
        {rows.map(([name, spec], i) => (
          <div key={i} className="grid grid-cols-[1fr_110px_1fr_auto_auto] items-center gap-2">
            <Input
              value={name}
              className="font-mono text-[12px]"
              placeholder="name"
              onChange={(e) => set(i, { name: e.target.value })}
              aria-label="Input name"
            />
            <Select value={spec.type} onChange={(e) => set(i, { type: e.target.value as typeof spec.type })} aria-label="Type">
              {['string', 'number', 'boolean', 'object', 'array'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Input
              value={spec.default === undefined ? '' : String(spec.default)}
              placeholder="default"
              onChange={(e) =>
                set(i, {
                  default:
                    e.target.value === ''
                      ? undefined
                      : spec.type === 'number'
                        ? Number(e.target.value)
                        : spec.type === 'boolean'
                          ? e.target.value === 'true'
                          : e.target.value,
                })
              }
              aria-label="Default"
            />
            <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <Switch checked={spec.required} onCheckedChange={(v) => set(i, { required: v })} label="Required" /> req.
            </label>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Remove input"
              onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}
              icon={<Trash2 className="size-3.5" />}
            />
          </div>
        ))}
        {!rows.length && <p className="text-[12.5px] text-fg-subtle">No inputs defined.</p>}
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          onClick={() => setRows((r) => [...r, [`input_${r.length + 1}`, { type: 'string', required: false }]])}
        >
          Add input
        </Button>
      </fieldset>
    </Dialog>
  );
}

// ─────────────── Triggers ───────────────
const EVENTS = [
  'jira.issue.transitioned',
  'jira.issue.created',
  'github.pull_request.opened',
  'github.pull_request.synchronize',
  'github.push',
  'github.issue_comment.created',
  'trello.card.moved',
  'devops.deployment.failed',
];

function TriggerDialog({
  open,
  workflow,
  onClose,
  onPending,
  onChanged,
}: {
  open: boolean;
  workflow: Workflow | null;
  onClose: () => void;
  onPending: (t: Record<string, unknown>) => void;
  onChanged: () => void;
}) {
  const [type, setType] = useState<'EVENT' | 'SCHEDULE'>('EVENT');
  const [event, setEvent] = useState(EVENTS[0]!);
  const [filter, setFilter] = useState("event.toStatus == 'Ready for Development'");
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const config = type === 'EVENT' ? { type, event, ...(filter.trim() && { filter }), inputs: {} } : { type, cron, timezone };
  const add = useAction(() => api.post(`/workflows/${workflow!.id}/triggers`, { config, enabled: true }), {
    success: 'Trigger added',
    onSuccess: () => (onChanged(), onClose()),
  });
  const remove = useAction((t: WorkflowTrigger) => api.del(`/workflows/${workflow!.id}/triggers/${t.id}`), {
    success: 'Trigger removed',
    onSuccess: onChanged,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Triggers"
      description="Start this flow automatically from an external event or on a schedule. Webhook events are signature-verified and de-duplicated."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={add.isPending}
            onClick={() => {
              if (workflow) add.mutate(undefined);
              else {
                onPending(config);
                onClose();
              }
            }}
          >
            {workflow ? 'Add trigger' : 'Add on save'}
          </Button>
        </>
      }
    >
      {workflow && workflow.triggers.filter((t) => t.type !== 'MANUAL').length > 0 && (
        <ul className="mb-4 space-y-1.5">
          {workflow.triggers
            .filter((t) => t.type !== 'MANUAL')
            .map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-[12.5px]">
                {t.type === 'SCHEDULE' ? <CalendarClock className="size-3.5 text-arc" /> : <Webhook className="size-3.5 text-arc" />}
                <Mono className="flex-1 truncate text-fg">
                  {t.type === 'SCHEDULE'
                    ? `${String(t.config.cron)} (${String(t.config.timezone ?? 'UTC')})`
                    : `${String(t.config.event)}${t.config.filter ? ` if ${String(t.config.filter)}` : ''}`}
                </Mono>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove trigger"
                  onClick={() => remove.mutate(t)}
                  icon={<Trash2 className="size-3.5" />}
                />
              </li>
            ))}
        </ul>
      )}
      <div className="space-y-4">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: 'EVENT', label: 'On event' },
            { value: 'SCHEDULE', label: 'On schedule' },
          ]}
        />
        {type === 'EVENT' ? (
          <>
            <Field label="Event">
              <Select value={event} onChange={(e) => setEvent(e.target.value)}>
                {EVENTS.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </Select>
            </Field>
            <Field label="Filter (optional)" hint="Expression over the event payload, e.g. event.toStatus == 'Ready for Development'">
              <Input value={filter} className="font-mono text-[12px]" onChange={(e) => setFilter(e.target.value)} />
            </Field>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cron" hint="minute hour day month weekday">
              <Input value={cron} className="font-mono text-[12px]" onChange={(e) => setCron(e.target.value)} />
            </Field>
            <Field label="Timezone">
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─────────────── Run ───────────────
function RunDialog({ open, workflow, onClose }: { open: boolean; workflow: Workflow; onClose: () => void }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string>>({});
  const run = useAction(
    () => {
      const input: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(workflow.definition.inputs)) {
        const v = values[k];
        if (v === undefined || v === '') continue;
        input[k] =
          spec.type === 'number'
            ? Number(v)
            : spec.type === 'boolean'
              ? v === 'true'
              : spec.type === 'object' || spec.type === 'array'
                ? JSON.parse(v)
                : v;
      }
      return api.post<{ id: string }>(`/workflows/${workflow.id}/run`, { projectId: workflow.projectId ?? undefined, input });
    },
    { success: 'Run started', invalidate: [['executions', 'list']], onSuccess: (e) => navigate(`/executions/${e.id}`) },
  );
  const inputs = Object.entries(workflow.definition.inputs);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Run ${workflow.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Play className="size-3.5" />} loading={run.isPending} onClick={() => run.mutate(undefined)}>
            Start run
          </Button>
        </>
      }
    >
      {!inputs.length ? (
        <p className="text-[13px] text-fg-muted">This flow has no inputs.</p>
      ) : (
        <div className="space-y-3">
          {inputs.map(([k, spec]) => (
            <Field key={k} label={k} required={spec.required} hint={spec.description}>
              <Input
                value={values[k] ?? (spec.default === undefined ? '' : String(spec.default))}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      )}
      <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
        <Wrench className="size-3" /> Gated steps pause for approval according to your project’s policy.
      </p>
    </Dialog>
  );
}
