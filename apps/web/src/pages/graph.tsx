import { memo, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  BookText,
  Boxes,
  CircleDot,
  Container,
  ExternalLink,
  FileText,
  FolderKanban,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Network,
  Rocket,
  Search,
  ShieldCheck,
  Ticket,
  TestTubes,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useGraph, useProjects } from '@/api/queries';
import type { GraphNode } from '@/api/types';
import { cn } from '@/lib/cn';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Input, Select } from '@/components/ui/form';
import { Card, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState } from '@/components/ui/page';
import { StatusDot } from '@/components/ui/status';
import { layout } from '@/features/flow-graph';

/** Visual identity per entity type in the Engineering Graph. */
const TYPES: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  project: { label: 'Project', icon: FolderKanban, color: '#ff6a3d' },
  repository: { label: 'Repository', icon: Boxes, color: '#ececee' },
  environment: { label: 'Environment', icon: Container, color: '#7dd3fc' },
  ticket: { label: 'Ticket', icon: Ticket, color: '#5cc8ff' },
  run: { label: 'Run', icon: Zap, color: '#a78bfa' },
  branch: { label: 'Branch', icon: GitBranch, color: '#f5b14c' },
  commit: { label: 'Commit', icon: GitCommitHorizontal, color: '#d6b98c' },
  pull_request: { label: 'Pull request', icon: GitPullRequest, color: '#3dd68c' },
  review: { label: 'Review', icon: ShieldCheck, color: '#f5b14c' },
  ci_run: { label: 'CI run', icon: CircleDot, color: '#7dd3fc' },
  qa_run: { label: 'QA run', icon: TestTubes, color: '#3dd68c' },
  deployment: { label: 'Deployment', icon: Rocket, color: '#ff6a3d' },
  document: { label: 'Document', icon: FileText, color: '#a2a3ab' },
  notion_page: { label: 'Notion page', icon: BookText, color: '#a2a3ab' },
};
const fallback = { label: 'Entity', icon: Network, color: '#a2a3ab' };

interface EntityData extends Record<string, unknown> {
  node: GraphNode;
  dimmed: boolean;
  highlighted: boolean;
}

const EntityNode = memo(function EntityNode({ data }: NodeProps<Node<EntityData>>) {
  const t = TYPES[data.node.type] ?? fallback;
  return (
    <div
      className={cn(
        'flex h-[46px] w-[208px] items-center gap-2 rounded-full border bg-raised pr-3 pl-1.5 shadow-card transition-opacity',
        data.highlighted ? 'border-accent ring-2 ring-accent/30' : 'border-line',
        data.dimmed && 'opacity-25',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in oklab, ${t.color} 16%, transparent)`, color: t.color }}
      >
        <t.icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] leading-tight font-medium">{data.node.label}</div>
        <div className="truncate text-[10.5px] text-fg-subtle">{data.node.sublabel ?? t.label}</div>
      </div>
      {data.node.status && <StatusDot status={data.node.status} />}
      {(data.node as { simulated?: boolean }).simulated && <span className="text-[9px] font-semibold text-warn uppercase">sim</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
const nodeTypes = { entity: EntityNode };

export function GraphPage() {
  useDocumentTitle('Engineering Graph');
  usePageContext({ title: 'Engineering Graph' });
  const navigate = useNavigate();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [runs, setRuns] = useState(20);
  const [hidden, setHidden] = useState<Set<string>>(new Set(['commit']));
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useGraph({ projectId: projectId || undefined, runs });

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data?.nodes ?? []) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [data]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const visible = data.nodes.filter((n) => !hidden.has(n.type));
    const ids = new Set(visible.map((n) => n.id));
    const es = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    // Neighbourhood of the focused/matched node stays bright.
    const q = query.trim().toLowerCase();
    const matched = q ? new Set(visible.filter((n) => `${n.label} ${n.sublabel ?? ''}`.toLowerCase().includes(q)).map((n) => n.id)) : null;
    const neighbours = new Set<string>();
    if (focus) {
      neighbours.add(focus);
      for (const e of es) {
        if (e.source === focus) neighbours.add(e.target);
        if (e.target === focus) neighbours.add(e.source);
      }
    }
    const ns: Node<EntityData>[] = visible.map((n) => ({
      id: n.id,
      type: 'entity',
      position: { x: 0, y: 0 },
      width: 208,
      height: 46,
      data: {
        node: n,
        highlighted: Boolean(matched?.has(n.id)) || n.id === focus,
        dimmed: (matched ? !matched.has(n.id) : false) || (focus ? !neighbours.has(n.id) : false),
      },
    }));
    const edgesOut: Edge[] = es.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? undefined,
      labelStyle: { fill: 'var(--color-fg-subtle)', fontSize: 9.5 },
      labelBgStyle: { fill: 'var(--color-canvas)' },
      style: { stroke: 'var(--color-line-strong)', opacity: focus && !(neighbours.has(e.source) && neighbours.has(e.target)) ? 0.15 : 1 },
    }));
    return { nodes: layout(ns, edgesOut, 'LR', { w: 208, h: 46 }), edges: edgesOut };
  }, [data, hidden, query, focus]);

  const selected = data?.nodes.find((n) => n.id === focus) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">Engineering Graph</h1>
          <p className="text-[11.5px] text-fg-subtle">How requirements, tickets, code, reviews, tests and deployments connect.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Input
              icon={<Search className="size-3.5" />}
              placeholder="Find a ticket, PR, run…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-48" aria-label="Project">
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select value={String(runs)} onChange={(e) => setRuns(Number(e.target.value))} className="w-36" aria-label="Runs included">
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                Last {n} runs
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line bg-surface px-4 py-2">
        {Object.entries(TYPES)
          .filter(([type]) => counts.has(type))
          .map(([type, t]) => {
            const off = hidden.has(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => setHidden((h) => (h.has(type) ? new Set([...h].filter((x) => x !== type)) : new Set([...h, type])))}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-opacity',
                  off ? 'border-line opacity-45' : 'border-line-strong',
                )}
                aria-pressed={!off}
              >
                <t.icon className="size-3" style={{ color: t.color }} />
                {t.label}
                <span className="font-mono text-[10px] text-fg-subtle">{counts.get(type)}</span>
              </button>
            );
          })}
      </div>
      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="p-6">
            <ErrorState error={error} onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <div className="p-6">
            <Skeleton className="h-full min-h-96" />
          </div>
        ) : !nodes.length ? (
          <EmptyState
            icon={<Network />}
            title="The graph fills as work flows"
            description="Each run links its ticket, branch, commits, pull request, review, CI, QA results, deployments and docs. Start a delivery to see it grow."
          />
        ) : (
          <div className="grid-dots h-full">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
              minZoom={0.1}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, n) => setFocus((f) => (f === n.id ? null : n.id))}
              onPaneClick={() => setFocus(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="transparent" />
              <Controls position="bottom-right" showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                position="bottom-left"
                style={{ width: 168, height: 96 }}
                className="!rounded-md !border !border-line"
                maskColor="color-mix(in oklab, var(--color-canvas) 70%, transparent)"
                nodeColor={(n) => (TYPES[(n.data as EntityData).node.type] ?? fallback).color}
              />
            </ReactFlow>
          </div>
        )}
        {selected && (
          <Card className="absolute top-3 right-3 w-72 p-3 shadow-pop">
            <div className="text-[11px] text-fg-subtle">{(TYPES[selected.type] ?? fallback).label}</div>
            <div className="mt-0.5 text-[13px] font-semibold">{selected.label}</div>
            {selected.sublabel && <div className="text-[12px] text-fg-muted">{selected.sublabel}</div>}
            <div className="mt-3 flex gap-2">
              {selected.link && (
                <button
                  type="button"
                  onClick={() => navigate(selected.link!)}
                  className="text-[12px] font-medium text-accent hover:underline"
                >
                  Open in Forgeline →
                </button>
              )}
              {selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-fg-muted hover:text-fg"
                >
                  External <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
