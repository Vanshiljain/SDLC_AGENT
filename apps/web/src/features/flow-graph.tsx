import { memo, useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Boxes,
  BookText,
  Clock,
  Code2,
  Hand,
  Layers,
  Repeat2,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Split,
  TestTubes,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { StepDefinition, WorkflowDefinition } from '@forgeline/shared';
import type { ExecutionStep } from '@/api/types';
import { cn } from '@/lib/cn';
import { formatDuration, titleCase } from '@/lib/format';
import { isLive, statusTone } from '@/components/ui/status';

export const NODE_W = 236;
export const NODE_H = 68;

/** Agent personas: colour + icon used consistently across runs, flows and the graph. */
export const AGENTS: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  planning: { label: 'Planning', icon: Layers, color: '#a78bfa' },
  architect: { label: 'Architecture', icon: ScanSearch, color: '#5cc8ff' },
  code: { label: 'Code', icon: Code2, color: '#ff8a5c' },
  review: { label: 'Review', icon: ShieldCheck, color: '#f5b14c' },
  qa: { label: 'QA', icon: TestTubes, color: '#3dd68c' },
  release: { label: 'Release', icon: Rocket, color: '#ff6a3d' },
  docs: { label: 'Docs', icon: BookText, color: '#7dd3fc' },
  orchestrator: { label: 'Forge', icon: Boxes, color: '#a78bfa' },
};

export function agentOf(step: { agent?: string | null; type?: string; tool?: string | null }) {
  if (step.type === 'approval') return { label: 'Approval', icon: Hand, color: 'var(--color-accent)' };
  if (step.type === 'condition') return { label: 'Condition', icon: Split, color: 'var(--color-fg-subtle)' };
  if (step.type === 'delay') return { label: 'Delay', icon: Clock, color: 'var(--color-fg-subtle)' };
  return (step.agent && AGENTS[step.agent]) || { label: step.tool?.split('.')[0] ?? 'Tool', icon: Wrench, color: 'var(--color-fg-subtle)' };
}

export function layout<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
  direction: 'LR' | 'TB' = 'LR',
  size = { w: NODE_W, h: NODE_H },
): N[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: direction === 'LR' ? 22 : 36,
    ranksep: direction === 'LR' ? 64 : 56,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: n.width ?? size.w, height: n.height ?? size.h }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - (n.width ?? size.w) / 2, y: p.y - (n.height ?? size.h) / 2 } };
  });
}

export interface StepNodeData extends Record<string, unknown> {
  step: StepDefinition;
  run?: ExecutionStep | null;
  iterations?: number;
  repairOf?: string | null;
  invalid?: boolean;
  selected?: boolean;
  direction?: 'LR' | 'TB';
}

const TONE_RING: Record<string, string> = {
  ok: 'border-ok/50',
  bad: 'border-bad/70',
  warn: 'border-warn/60',
  arc: 'border-arc/70',
  accent: 'border-accent/80',
  ai: 'border-ai/70',
  neutral: 'border-line',
};

export const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const { step, run, iterations, repairOf, invalid, direction = 'LR' } = data;
  const a = agentOf(step);
  const status = run?.status ?? null;
  const tone = status ? statusTone(status) : 'neutral';
  const live = isLive(status);
  const skipped = status === 'SKIPPED';
  return (
    <div
      className={cn(
        'relative h-[68px] w-[236px] overflow-hidden rounded-lg border bg-raised shadow-card transition-[border-color,box-shadow,opacity]',
        TONE_RING[tone],
        skipped && 'opacity-45',
        repairOf && 'border-dashed',
        invalid && 'border-bad',
        selected && 'ring-2 ring-accent/50',
        live && 'shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-arc)_14%,transparent)]',
      )}
    >
      <Handle type="target" position={direction === 'LR' ? Position.Left : Position.Top} isConnectable={false} />
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: a.color }} />
      {live && <span className="absolute inset-x-0 bottom-0 h-[2px] forge-line" />}
      <div className="flex h-full items-center gap-2.5 pr-3 pl-3.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: `color-mix(in oklab, ${a.color} 14%, transparent)`, color: a.color }}
        >
          <a.icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium">{step.name}</span>
            {step.type === 'approval' || step.approval ? <Hand className="size-3 shrink-0 text-accent" /> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-fg-subtle">
            <span className="truncate font-mono">{repairOf ? `repairs ${repairOf}` : (step.tool ?? step.type)}</span>
            {run?.durationMs ? <span className="ml-auto shrink-0 font-mono">{formatDuration(run.durationMs)}</span> : null}
          </div>
        </div>
        {(iterations ?? 0) > 0 && (
          <span
            title={`Self-healed ${iterations}×`}
            className="flex shrink-0 items-center gap-0.5 rounded-sm bg-ai-soft px-1 font-mono text-[10px] text-ai"
          >
            <Repeat2 className="size-2.5" />
            {iterations}
          </span>
        )}
        {status && <StatusPip status={status} />}
      </div>
      <Handle type="source" position={direction === 'LR' ? Position.Right : Position.Bottom} isConnectable={false} />
    </div>
  );
});

function StatusPip({ status }: { status: string }) {
  const tone = statusTone(status);
  const bg = { ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn', arc: 'bg-arc', accent: 'bg-accent', ai: 'bg-ai', neutral: 'bg-fg-subtle' }[
    tone
  ];
  return (
    <span
      title={titleCase(status)}
      className={cn(
        'size-2 shrink-0 rounded-full',
        bg,
        isLive(status) && 'animate-pulse-dot',
        tone === 'arc' ? 'text-arc' : tone === 'accent' ? 'text-accent' : 'text-ai',
      )}
    />
  );
}

export const nodeTypes = { step: StepNode };

/** Latest attempt/iteration of each step key. */
export function latestSteps(steps: ExecutionStep[]): Map<string, { run: ExecutionStep; iterations: number }> {
  const map = new Map<string, { run: ExecutionStep; iterations: number }>();
  for (const s of steps) {
    const cur = map.get(s.stepKey);
    if (!cur || s.iteration > cur.run.iteration || (s.iteration === cur.run.iteration && s.position >= cur.run.position))
      map.set(s.stepKey, { run: s, iterations: Math.max(cur?.iterations ?? 0, s.iteration) });
    else cur.iterations = Math.max(cur.iterations, s.iteration);
  }
  return map;
}

export function buildFlowGraph(
  definition: WorkflowDefinition,
  runSteps: ExecutionStep[] = [],
  direction: 'LR' | 'TB' = 'LR',
  selectedKey?: string | null,
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const latest = latestSteps(runSteps);
  const repairOf = new Map<string, string>();
  for (const s of definition.steps) if (s.repair) repairOf.set(s.repair.step, s.key);
  const nodes: Node<StepNodeData>[] = definition.steps.map((step) => ({
    id: step.key,
    type: 'step',
    position: { x: 0, y: 0 },
    width: NODE_W,
    height: NODE_H,
    selected: step.key === selectedKey,
    data: {
      step,
      run: latest.get(step.key)?.run ?? null,
      iterations: latest.get(step.key)?.iterations ?? 0,
      repairOf: repairOf.get(step.key) ?? null,
      direction,
    },
  }));
  const edges: Edge[] = [];
  for (const step of definition.steps) {
    const target = latest.get(step.key)?.run;
    for (const dep of step.dependsOn) {
      const source = latest.get(dep)?.run;
      const active = target && isLive(target.status);
      const done = source?.status === 'COMPLETED' && target && target.status !== 'PENDING' && target.status !== 'SKIPPED';
      edges.push({
        id: `${dep}->${step.key}`,
        source: dep,
        target: step.key,
        animated: Boolean(active),
        style: {
          strokeWidth: done || active ? 1.6 : 1.2,
          stroke: done ? 'var(--color-ok)' : undefined,
          opacity: target?.status === 'SKIPPED' ? 0.35 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: done ? 'var(--color-ok)' : 'var(--color-line-strong)' },
      });
    }
    if (step.repair) {
      edges.push({
        id: `${step.key}~>${step.repair.step}`,
        source: step.key,
        target: step.repair.step,
        style: { strokeDasharray: '4 4', stroke: 'var(--color-ai)', opacity: 0.7 },
        label: 'repair',
        labelStyle: { fill: 'var(--color-ai)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--color-canvas)' },
      });
    }
  }
  const layoutEdges = edges.filter((e) => !e.id.includes('~>'));
  // Repair steps hang off their target in the layout.
  for (const [repair, target] of repairOf) layoutEdges.push({ id: `layout:${target}:${repair}`, source: target, target: repair });
  return { nodes: layout(nodes, layoutEdges, direction), edges };
}

export function RunGraph({
  definition,
  steps,
  onSelect,
  selectedKey,
  className,
  direction = 'LR',
}: {
  definition: WorkflowDefinition;
  steps: ExecutionStep[];
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  className?: string;
  direction?: 'LR' | 'TB';
}) {
  const { nodes, edges } = useMemo(
    () => buildFlowGraph(definition, steps, direction, selectedKey),
    [definition, steps, direction, selectedKey],
  );
  const large = nodes.length > 10;
  // Large flows open centred on the active (or most recent) step at a readable zoom.
  const onInit = (instance: ReactFlowInstance<Node<StepNodeData>>) => {
    if (!large) return;
    const active = nodes.find((n) => n.data.run && isLive(n.data.run.status));
    const failed = nodes.find((n) => n.data.run?.status === 'FAILED');
    const first = [...nodes].sort((a, b) => a.position.x + a.position.y - (b.position.x + b.position.y))[0];
    const focus = active ?? failed ?? first;
    if (focus) void instance.setCenter(focus.position.x + NODE_W / 2, focus.position.y + NODE_H / 2, { zoom: 0.85 });
  };
  return (
    <div className={cn('grid-dots h-full w-full', className)}>
      <ReactFlow
        key={direction}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView={!large}
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        onInit={onInit}
        minZoom={0.15}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, n) => onSelect?.(n.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="transparent" />
        <Controls showInteractive={false} position="bottom-right" />
        {large && <FlowMiniMap />}
      </ReactFlow>
    </div>
  );
}

export function FlowMiniMap() {
  return (
    <MiniMap
      pannable
      zoomable
      position="bottom-left"
      style={{ width: 168, height: 96 }}
      className="!rounded-md !border !border-line !shadow-card"
      maskColor="color-mix(in oklab, var(--color-canvas) 70%, transparent)"
      nodeBorderRadius={4}
      nodeColor={(n) => {
        const run = (n.data as StepNodeData).run;
        const tone = run ? statusTone(run.status) : 'neutral';
        return {
          ok: 'var(--color-ok)',
          bad: 'var(--color-bad)',
          warn: 'var(--color-warn)',
          arc: 'var(--color-arc)',
          accent: 'var(--color-accent)',
          ai: 'var(--color-ai)',
          neutral: 'var(--color-line-strong)',
        }[tone];
      }}
    />
  );
}
