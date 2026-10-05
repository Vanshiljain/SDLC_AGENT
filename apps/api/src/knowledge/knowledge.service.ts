import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@forgeline/database';
import {
  assembleContext,
  chunkContent,
  chunkPointId,
  contentHash,
  detectKind,
  estimateTokens,
  KnowledgeRetriever,
  looksBinary,
  normalizeContent,
  type ContextSource,
  type LlmProvider,
  type VectorStore,
} from '@forgeline/ai';
import { adfToText, NotionClient, safeFetch } from '@forgeline/integrations';
import { ToolError, type KnowledgeSourceType } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { EventBus } from '../events/event-bus.service';
import { JobQueue } from '../queues/job-queue.service';
import { ConnectionResolver } from '../integrations/connection-resolver.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import type { AuthContext } from '../common/auth/auth-context';
import { paginate, skipTake } from '../common/pagination';
import { LLM_PROVIDER, VECTOR_STORE } from './knowledge.tokens';

export interface IngestTextParams {
  organizationId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  userId?: string | null;
  sourceType: KnowledgeSourceType;
  sourceRef: string;
  title: string;
  content: string;
  documentType?: string;
  url?: string | null;
  branch?: string | null;
  environment?: string | null;
  metadata?: Record<string, unknown>;
  path?: string | null;
}

const MAX_DOCUMENT_CHARS = 400_000;
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|php|scala|swift|c|cc|cpp|h|cs|sql|prisma|graphql|proto|ya?ml|toml|json|md|mdx|rst|txt|sh|tf|css|scss|html|vue|svelte)$/i;
const EXCLUDED_PATHS = /(^|\/)(node_modules|dist|build|coverage|vendor|\.git|\.next|out|target)\/|(\.min\.(js|css)$)|(lock(file)?\.(json|yaml)$)|(-lock\.json$)|(\.lock$)/i;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, l: string) => `\n${'#'.repeat(Number(l))} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Knowledge / RAG pipeline:
 *   source → ingestion → parsing → chunking → metadata → embeddings → Qdrant
 *   → tenant-filtered semantic retrieval → context assembly → LLM.
 */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly queue: JobQueue,
    private readonly connections: ConnectionResolver,
    @Inject(VECTOR_STORE) private readonly vectors: VectorStore,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queue.register('knowledge.ingest', (data) => this.process(String(data.documentId)));
    // Completed runs become searchable knowledge ("previous agent executions").
    this.events.on('workflow.completed', (e) => (e.executionId ? this.ingestExecution(e.organizationId, e.executionId) : undefined));
    this.events.on('workflow.failed', (e) => (e.executionId ? this.ingestExecution(e.organizationId, e.executionId) : undefined));
  }

  get embeddingsAvailable(): boolean {
    return this.llm.isConfigured();
  }

  // ───────────────────────── ingestion ─────────────────────────

  /** Upsert a document by (org, sourceType, sourceRef) and enqueue indexing when content changed. */
  async ingestText(p: IngestTextParams) {
    const content = normalizeContent(p.content).slice(0, MAX_DOCUMENT_CHARS);
    if (!content) throw AppException.badRequest('Document is empty', 'EMPTY_DOCUMENT');
    if (looksBinary(content)) throw AppException.badRequest('Binary content cannot be indexed', 'BINARY_CONTENT');
    const hash = contentHash(content);
    const existing = await this.prisma.knowledgeDocument.findUnique({
      where: { organizationId_sourceType_sourceRef: { organizationId: p.organizationId, sourceType: p.sourceType, sourceRef: p.sourceRef } },
    });
    if (existing && existing.contentHash === hash && existing.status === 'INDEXED' && !existing.deletedAt) return existing;
    const data = {
      projectId: p.projectId ?? null,
      repositoryId: p.repositoryId ?? null,
      title: p.title.slice(0, 300),
      documentType: p.documentType ?? 'document',
      contentHash: hash,
      status: 'PENDING' as const,
      content,
      url: p.url ?? null,
      branch: p.branch ?? null,
      environment: p.environment ?? null,
      metadata: { ...(p.metadata ?? {}), ...(p.path && { path: p.path }) } as Prisma.InputJsonValue,
      error: null,
      deletedAt: null,
      tokenCount: estimateTokens(content),
    };
    const doc = existing
      ? await this.prisma.knowledgeDocument.update({ where: { id: existing.id }, data })
      : await this.prisma.knowledgeDocument.create({ data: { ...data, organizationId: p.organizationId, sourceType: p.sourceType, sourceRef: p.sourceRef, createdById: p.userId ?? null } });
    await this.queue.add('knowledge.ingest', { documentId: doc.id }, { jobId: `ingest:${doc.id}:${hash.slice(0, 12)}` });
    return doc;
  }

  async process(documentId: string): Promise<void> {
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt || !doc.content) return;
    const claim = await this.prisma.knowledgeDocument.updateMany({ where: { id: documentId, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'PROCESSING' } });
    if (!claim.count) return;
    await this.publishStatus(doc.organizationId, doc.id, 'PROCESSING', doc.title);
    try {
      if (!this.llm.isConfigured()) throw new ToolError('not_configured', 'Embeddings unavailable: set OPENAI_API_KEY to index knowledge', { retryable: false });
      const path = (doc.metadata as { path?: string }).path ?? (doc.sourceType === 'UPLOAD' ? doc.title : null);
      const kind = detectKind(path, doc.sourceType === 'NOTION' || doc.documentType === 'markdown' ? 'markdown' : 'text');
      const chunks = await chunkContent(doc.content, kind);
      const embeddings = this.llm.embeddings();
      await this.vectors.ensureCollection(this.llm.embeddingDimensions);
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += 64) {
        const batch = chunks.slice(i, i + 64).map((c) => `${doc.title}${c.heading ? ` › ${c.heading}` : ''}\n\n${c.text}`);
        vectors.push(...(await embeddings.embedDocuments(batch)));
      }
      await this.vectors.deleteDocument(doc.organizationId, doc.id);
      const indexedAt = new Date().toISOString();
      await this.vectors.upsert(
        chunks.map((c, i) => ({
          id: chunkPointId(doc.id, c.index),
          vector: vectors[i]!,
          payload: {
            organizationId: doc.organizationId,
            projectId: doc.projectId,
            repositoryId: doc.repositoryId,
            documentId: doc.id,
            documentType: doc.documentType,
            sourceType: doc.sourceType,
            source: doc.sourceRef,
            title: doc.title,
            chunkIndex: c.index,
            text: c.text,
            startLine: kind.kind === 'code' ? c.startLine : null,
            endLine: kind.kind === 'code' ? c.endLine : null,
            heading: c.heading,
            branch: doc.branch,
            environment: doc.environment,
            url: doc.url,
            indexedAt,
          },
        })),
      );
      await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'INDEXED', chunkCount: chunks.length, indexedAt: new Date(), error: null } });
      await this.publishStatus(doc.organizationId, doc.id, 'INDEXED', doc.title, chunks.length);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn({ err: message, documentId }, 'Knowledge ingestion failed');
      await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'FAILED', error: message.slice(0, 1000) } });
      await this.publishStatus(doc.organizationId, doc.id, 'FAILED', doc.title, 0, message);
    }
  }

  private publishStatus(organizationId: string, documentId: string, status: string, title: string, chunks = 0, error?: string) {
    return this.events.publish({ type: 'knowledge.document.status', organizationId, data: { documentId, status, title, chunks, error: error ?? null } });
  }

  async ingestUpload(auth: AuthContext, file: { originalname: string; buffer: Buffer; size: number }, params: { projectId?: string; documentType?: string; sourceType?: KnowledgeSourceType }) {
    if (file.size > 2 * 1024 * 1024) throw AppException.badRequest('Files up to 2 MB are supported', 'FILE_TOO_LARGE');
    if (!CODE_EXTENSIONS.test(file.originalname) && !/\.(txt|log|csv|adoc)$/i.test(file.originalname)) {
      throw AppException.badRequest('Unsupported file type. Upload text, Markdown or source files.', 'UNSUPPORTED_FILE');
    }
    const content = file.buffer.toString('utf8');
    const doc = await this.ingestText({
      organizationId: auth.organizationId,
      projectId: params.projectId,
      userId: auth.userId,
      sourceType: params.sourceType ?? 'UPLOAD',
      sourceRef: `upload:${params.projectId ?? 'org'}:${file.originalname}`,
      title: file.originalname,
      content,
      documentType: params.documentType ?? (/\.(md|mdx|rst)$/i.test(file.originalname) ? 'markdown' : 'document'),
      path: file.originalname,
    });
    await this.audit.record({ organizationId: auth.organizationId, action: 'knowledge.uploaded', resourceType: 'knowledge_document', resourceId: doc.id, projectId: params.projectId, input: { name: file.originalname, size: file.size } });
    return doc;
  }

  async ingestUrl(auth: AuthContext, url: string, params: { projectId?: string; documentType?: string; sourceType?: KnowledgeSourceType }) {
    const res = await safeFetch(url, { headers: { Accept: 'text/html,text/plain,text/markdown,application/json' }, timeoutMs: 15_000 }, this.config.outbound);
    if (res.status >= 400) throw AppException.badRequest(`Fetching ${url} returned ${res.status}`, 'FETCH_FAILED');
    const type = res.headers.get('content-type') ?? '';
    const text = type.includes('html') ? htmlToText(res.body) : res.body;
    const title = /<title>([^<]+)<\/title>/i.exec(res.body)?.[1]?.trim() ?? new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
    return this.ingestText({ organizationId: auth.organizationId, projectId: params.projectId, userId: auth.userId, sourceType: params.sourceType ?? 'URL', sourceRef: url, title, content: text, url, documentType: params.documentType ?? 'web' });
  }

  async ingestGitHubRepository(auth: AuthContext, projectId: string, params: { ref?: string; maxFiles?: number; pathPrefix?: string }) {
    const repo = await this.prisma.repository.findFirst({ where: { projectId, organizationId: auth.organizationId, deletedAt: null } });
    if (!repo) throw AppException.precondition('Link a GitHub repository to this project first', 'NO_REPOSITORY');
    const gh = await this.connections.github(auth.organizationId);
    const ref = params.ref ?? repo.defaultBranch;
    const sha = await gh.getBranchSha(repo.owner, repo.name, ref);
    if (!sha) throw AppException.notFound('Branch', ref);
    const { tree } = await gh.getTree(repo.owner, repo.name, sha);
    const files = tree
      .filter((t) => t.type === 'blob' && (t.size ?? 0) < 200_000 && CODE_EXTENSIONS.test(t.path) && !EXCLUDED_PATHS.test(t.path) && (!params.pathPrefix || t.path.startsWith(params.pathPrefix)))
      .slice(0, Math.min(params.maxFiles ?? 400, 1000));
    let queued = 0;
    for (const f of files) {
      try {
        const content = await gh.getBlob(repo.owner, repo.name, f.sha);
        if (!content.trim() || looksBinary(content)) continue;
        await this.ingestText({
          organizationId: auth.organizationId,
          projectId,
          repositoryId: repo.id,
          userId: auth.userId,
          sourceType: 'GITHUB',
          sourceRef: `${repo.fullName}@${ref}:${f.path}`,
          title: f.path,
          content,
          documentType: /\.(md|mdx|rst)$/i.test(f.path) ? 'markdown' : 'code',
          url: `${repo.url ?? `https://github.com/${repo.fullName}`}/blob/${ref}/${f.path}`,
          branch: ref,
          path: f.path,
        });
        queued++;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, path: f.path }, 'Skipping file');
      }
    }
    await this.prisma.repository.update({ where: { id: repo.id }, data: { lastIndexedAt: new Date() } });
    await this.audit.record({ organizationId: auth.organizationId, action: 'knowledge.repository_indexed', resourceType: 'repository', resourceId: repo.id, projectId, output: { files: queued, ref } });
    return { repository: repo.fullName, ref, filesQueued: queued, filesConsidered: files.length };
  }

  async ingestJira(auth: AuthContext, projectId: string | undefined, jql: string) {
    const jira = await this.connections.clientsFor(auth.organizationId, null).jira();
    const issues = await jira.searchIssues(jql, 50);
    let queued = 0;
    for (const i of issues) {
      const full = await jira.getIssue(i.key);
      await this.ingestText({
        organizationId: auth.organizationId,
        projectId,
        userId: auth.userId,
        sourceType: 'JIRA',
        sourceRef: `jira:${i.key}`,
        title: `${i.key}: ${full.fields.summary}`,
        content: `# ${i.key}: ${full.fields.summary}\n\nStatus: ${full.fields.status?.name ?? 'unknown'}\nType: ${full.fields.issuetype?.name ?? ''}\nLabels: ${(full.fields.labels ?? []).join(', ')}\n\n${adfToText(full.fields.description)}`,
        documentType: 'ticket',
        url: jira.browseUrl(i.key),
      });
      queued++;
    }
    return { issuesQueued: queued };
  }

  async ingestNotion(auth: AuthContext, projectId: string | undefined, query: string) {
    const notion = await this.connections.clientsFor(auth.organizationId, null).notion();
    const pages = await notion.search(query, 25);
    let queued = 0;
    for (const p of pages) {
      const page = await notion.getPageMarkdown(p.id);
      if (!page.markdown.trim()) continue;
      await this.ingestText({ organizationId: auth.organizationId, projectId, userId: auth.userId, sourceType: 'NOTION', sourceRef: `notion:${p.id}`, title: NotionClient.pageTitle(p), content: page.markdown, documentType: 'markdown', url: page.url });
      queued++;
    }
    return { pagesQueued: queued };
  }

  /** Index a finished run (steps, decisions, artifacts) as institutional memory. */
  async ingestExecution(organizationId: string, executionId: string): Promise<void> {
    try {
      const e = await this.prisma.workflowExecution.findUnique({ where: { id: executionId }, include: { steps: { orderBy: { position: 'asc' } }, artifacts: { select: { type: true, title: true, content: true } } } });
      if (!e || e.mode === 'DEMO') return;
      const lines = [
        `# Run: ${e.title}`,
        `Status: ${e.status} · Template: ${e.template ?? 'custom'} · Finished: ${e.completedAt?.toISOString() ?? 'n/a'}`,
        '',
        '## Steps',
        ...e.steps.map((s) => `- ${s.name} [${s.status}]${s.summary ? ` — ${s.summary}` : ''}`),
        ...e.artifacts.filter((a) => ['SPECIFICATION', 'IMPLEMENTATION_PLAN', 'REVIEW_REPORT', 'TEST_REPORT'].includes(a.type)).map((a) => `\n## ${a.title}\n\n${a.content.slice(0, 8000)}`),
      ];
      await this.ingestText({ organizationId, projectId: e.projectId, sourceType: 'EXECUTION', sourceRef: `execution:${e.id}`, title: `Run: ${e.title}`, content: lines.join('\n'), documentType: 'execution' });
    } catch (err) {
      this.logger.debug({ err: (err as Error).message, executionId }, 'Execution not indexed');
    }
  }

  // ───────────────────────── retrieval ─────────────────────────

  async retrieve(params: { organizationId: string; projectId?: string | null; query: string; k?: number; documentTypes?: string[]; sourceTypes?: string[]; maxChars?: number }): Promise<{ context: string; sources: ContextSource[]; available: boolean }> {
    if (!this.llm.isConfigured()) return { context: 'Knowledge retrieval unavailable: embeddings are not configured.', sources: [], available: false };
    const indexed = await this.prisma.knowledgeDocument.count({ where: { organizationId: params.organizationId, status: 'INDEXED', deletedAt: null } });
    if (!indexed) return { context: 'No knowledge has been indexed for this organization yet.', sources: [], available: true };
    await this.vectors.ensureCollection(this.llm.embeddingDimensions);
    const retriever = new KnowledgeRetriever({
      store: this.vectors,
      embeddings: this.llm.embeddings(),
      filter: { organizationId: params.organizationId, projectId: params.projectId ?? undefined, documentTypes: params.documentTypes, sourceTypes: params.sourceTypes },
      k: params.k ?? 8,
      scoreThreshold: 0.2,
    });
    const docs = await retriever.invoke(params.query);
    const { text, sources } = assembleContext(docs, params.maxChars ?? 12_000);
    return { context: text, sources, available: true };
  }

  async search(auth: AuthContext, q: { query: string; projectId?: string; documentTypes?: string[]; sourceTypes?: string[]; k?: number }) {
    const res = await this.retrieve({ organizationId: auth.organizationId, projectId: q.projectId, query: q.query, k: q.k ?? 10, documentTypes: q.documentTypes, sourceTypes: q.sourceTypes });
    return res;
  }

  async list(auth: AuthContext, q: { page: number; pageSize: number; projectId?: string; sourceType?: KnowledgeSourceType; status?: string; search?: string }) {
    const where: Prisma.KnowledgeDocumentWhereInput = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.sourceType && { sourceType: q.sourceType }),
      ...(q.status && { status: q.status as never }),
      ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, select: { id: true, title: true, sourceType: true, sourceRef: true, documentType: true, status: true, chunkCount: true, tokenCount: true, url: true, error: true, indexedAt: true, updatedAt: true, projectId: true, branch: true }, ...skipTake(q) }),
      this.prisma.knowledgeDocument.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async stats(auth: AuthContext) {
    const [bySource, byStatus, chunks] = await Promise.all([
      this.prisma.knowledgeDocument.groupBy({ by: ['sourceType'], where: { organizationId: auth.organizationId, deletedAt: null }, _count: true }),
      this.prisma.knowledgeDocument.groupBy({ by: ['status'], where: { organizationId: auth.organizationId, deletedAt: null }, _count: true }),
      this.prisma.knowledgeDocument.aggregate({ where: { organizationId: auth.organizationId, deletedAt: null, status: 'INDEXED' }, _sum: { chunkCount: true, tokenCount: true } }),
    ]);
    return {
      embeddingsAvailable: this.embeddingsAvailable,
      vectorStore: await this.vectors.health(),
      embeddingModel: this.llm.embeddingModelName,
      bySource: Object.fromEntries(bySource.map((r) => [r.sourceType, r._count])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
      chunks: chunks._sum.chunkCount ?? 0,
      tokens: chunks._sum.tokenCount ?? 0,
    };
  }

  async get(auth: AuthContext, id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
    if (!doc) throw AppException.notFound('Document', id);
    return doc;
  }

  async reindex(auth: AuthContext, id: string) {
    const doc = await this.get(auth, id);
    await this.prisma.knowledgeDocument.update({ where: { id }, data: { status: 'PENDING' } });
    await this.queue.add('knowledge.ingest', { documentId: doc.id }, { jobId: `reindex:${doc.id}:${Date.now()}` });
    return { queued: true };
  }

  async remove(auth: AuthContext, id: string) {
    const doc = await this.get(auth, id);
    await this.vectors.deleteDocument(auth.organizationId, doc.id).catch((err: unknown) => this.logger.warn({ err }, 'Vector deletion failed'));
    await this.prisma.knowledgeDocument.update({ where: { id }, data: { deletedAt: new Date(), content: null } });
    await this.audit.record({ organizationId: auth.organizationId, action: 'knowledge.deleted', resourceType: 'knowledge_document', resourceId: id });
  }
}
