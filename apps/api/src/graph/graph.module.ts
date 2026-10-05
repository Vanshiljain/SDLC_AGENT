import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PrismaService } from '../common/prisma/prisma.service';

export interface GraphNode {
  id: string;
  type: 'project' | 'repository' | 'environment' | 'run' | 'ticket' | 'pull_request' | 'branch' | 'commit' | 'ci_run' | 'notion_page' | 'deployment' | 'document' | 'qa_run' | 'review' | 'trello_card' | 'issue' | 'artifact';
  label: string;
  sublabel?: string | null;
  status?: string | null;
  url?: string | null;
  link?: string | null;
  simulated?: boolean;
  createdAt?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

const RESOURCE_TYPE: Record<string, GraphNode['type']> = {
  JIRA_ISSUE: 'ticket',
  TRELLO_CARD: 'trello_card',
  GITHUB_PULL_REQUEST: 'pull_request',
  GITHUB_BRANCH: 'branch',
  GITHUB_COMMIT: 'commit',
  GITHUB_ISSUE: 'issue',
  CI_RUN: 'ci_run',
  NOTION_PAGE: 'notion_page',
  DEPLOYMENT: 'deployment',
  GITHUB_REPOSITORY: 'repository',
  CONTAINER_IMAGE: 'artifact',
  BUILD_ARTIFACT: 'artifact',
};

/**
 * Engineering Graph: a projection connecting projects, repositories,
 * environments, runs and everything runs touched (tickets, PRs, CI, docs,
 * deployments, QA, reviews).
 */
@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService) {}

  async build(organizationId: string, opts: { projectId?: string; runs?: number }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const add = (n: GraphNode) => nodes.set(n.id, { ...nodes.get(n.id), ...n });
    const link = (source: string, target: string, label?: string) => {
      if (source === target || !nodes.has(source) || !nodes.has(target)) return;
      edges.set(`${source}->${target}`, { id: `${source}->${target}`, source, target, label });
    };
    const projectFilter = opts.projectId ? { projectId: opts.projectId } : {};

    const projects = await this.prisma.project.findMany({
      where: { organizationId, deletedAt: null, ...(opts.projectId && { id: opts.projectId }) },
      include: { repositories: { where: { deletedAt: null } }, environments: true },
    });
    for (const p of projects) {
      add({ id: `project:${p.id}`, type: 'project', label: p.name, sublabel: p.key, link: `/projects/${p.id}` });
      for (const r of p.repositories) {
        add({ id: `repo:${r.id}`, type: 'repository', label: r.fullName, sublabel: r.defaultBranch, url: r.url });
        link(`project:${p.id}`, `repo:${r.id}`, 'repository');
      }
      for (const e of p.environments) {
        add({ id: `env:${e.id}`, type: 'environment', label: e.name, sublabel: e.type.toLowerCase(), url: e.url });
        link(`project:${p.id}`, `env:${e.id}`, 'environment');
      }
    }

    const runs = await this.prisma.workflowExecution.findMany({
      where: { organizationId, ...projectFilter },
      orderBy: { createdAt: 'desc' },
      take: opts.runs ?? 40,
      select: { id: true, title: true, status: true, projectId: true, mode: true, createdAt: true },
    });
    const runIds = runs.map((r) => r.id);
    for (const r of runs) {
      add({ id: `run:${r.id}`, type: 'run', label: r.title, status: r.status, link: `/executions/${r.id}`, simulated: r.mode === 'DEMO', createdAt: r.createdAt.toISOString() });
      if (r.projectId) link(`project:${r.projectId}`, `run:${r.id}`, 'run');
    }

    const [resources, deployments, documents, qaRuns, reviews] = await Promise.all([
      this.prisma.externalResource.findMany({ where: { organizationId, OR: [{ executionId: { in: runIds } }, { ...projectFilter, executionId: null }] }, take: 500 }),
      this.prisma.deployment.findMany({ where: { organizationId, ...projectFilter }, orderBy: { createdAt: 'desc' }, take: 60, include: { environment: { select: { name: true } } } }),
      this.prisma.document.findMany({ where: { organizationId, deletedAt: null, ...projectFilter }, orderBy: { updatedAt: 'desc' }, take: 40 }),
      this.prisma.qATestRun.findMany({ where: { organizationId, executionId: { in: runIds } }, select: { id: true, title: true, status: true, executionId: true, passed: true, total: true, simulated: true } }),
      this.prisma.codeReview.findMany({ where: { organizationId, executionId: { in: runIds } }, select: { id: true, title: true, verdict: true, executionId: true, criticalCount: true, highCount: true, simulated: true } }),
    ]);

    for (const res of resources) {
      const type = RESOURCE_TYPE[res.type] ?? 'artifact';
      if (type === 'deployment') continue; // represented by Deployment rows
      add({ id: `res:${res.id}`, type, label: res.key ?? res.title ?? res.externalId, sublabel: res.title, status: res.status, url: res.url, simulated: res.simulated });
    }
    for (const res of resources) {
      if (!nodes.has(`res:${res.id}`)) continue;
      if (res.executionId) link(`run:${res.executionId}`, `res:${res.id}`, res.stepKey ?? undefined);
      else if (res.projectId) link(`project:${res.projectId}`, `res:${res.id}`);
      if (res.parentId) link(`res:${res.parentId}`, `res:${res.id}`);
    }
    // Tickets lead to the PRs produced in the same run (ticket → PR → CI).
    const byRun = new Map<string, typeof resources>();
    for (const r of resources) if (r.executionId) byRun.set(r.executionId, [...(byRun.get(r.executionId) ?? []), r]);
    for (const group of byRun.values()) {
      const ticket = group.find((r) => r.type === 'JIRA_ISSUE' || r.type === 'TRELLO_CARD');
      const pr = group.find((r) => r.type === 'GITHUB_PULL_REQUEST');
      if (ticket && pr) link(`res:${ticket.id}`, `res:${pr.id}`, 'implemented by');
      if (pr) for (const ci of group.filter((r) => r.type === 'CI_RUN')) link(`res:${pr.id}`, `res:${ci.id}`, 'checks');
    }

    for (const d of deployments) {
      add({ id: `deploy:${d.id}`, type: 'deployment', label: `${d.environment.name} · ${d.version}`, status: d.status, link: d.executionId ? `/executions/${d.executionId}` : '/deployments', simulated: d.simulated, createdAt: d.createdAt.toISOString() });
      link(`env:${d.environmentId}`, `deploy:${d.id}`, 'deployed');
      if (d.executionId) link(`run:${d.executionId}`, `deploy:${d.id}`, 'deploys');
    }
    for (const doc of documents) {
      add({ id: `doc:${doc.id}`, type: 'document', label: doc.title, sublabel: doc.type.toLowerCase(), url: doc.externalUrl, link: `/documents?focus=${doc.id}` });
      if (doc.executionId) link(`run:${doc.executionId}`, `doc:${doc.id}`, 'documents');
      else if (doc.projectId) link(`project:${doc.projectId}`, `doc:${doc.id}`);
    }
    for (const q of qaRuns) {
      add({ id: `qa:${q.id}`, type: 'qa_run', label: q.title, sublabel: q.total ? `${q.passed}/${q.total}` : null, status: q.status, simulated: q.simulated, link: '/qa' });
      if (q.executionId) link(`run:${q.executionId}`, `qa:${q.id}`, 'tested');
    }
    for (const r of reviews) {
      add({ id: `review:${r.id}`, type: 'review', label: r.title, sublabel: r.verdict, status: r.criticalCount ? 'FAILED' : r.highCount ? 'WARNING' : 'COMPLETED', simulated: r.simulated, link: '/code-reviews' });
      if (r.executionId) link(`run:${r.executionId}`, `review:${r.id}`, 'reviewed');
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}

class GraphQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) runs?: number;
}

@ApiTags('graph')
@ApiBearerAuth()
@Controller('graph')
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get()
  @ApiOperation({ summary: 'Engineering Graph nodes and edges' })
  @RequirePermissions('project:read')
  get(@CurrentAuth() auth: AuthContext, @Query() q: GraphQuery) {
    return this.graph.build(auth.organizationId, q);
  }
}

@Module({ controllers: [GraphController], providers: [GraphService] })
export class GraphModule {}
