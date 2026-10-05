import type { z } from 'zod';
import type {
  ArtifactType,
  ExecutionMode,
  ExternalResourceType,
  IntegrationProvider,
  NodeCategory,
  Permission,
  RetryPolicy,
} from '@forgeline/shared';
import type { GitHubClient } from '../github/client';
import type { JiraClient } from '../jira/client';
import type { TrelloClient } from '../trello/client';
import type { NotionClient } from '../notion/client';
import type { CiCdProvider } from '../devops/cicd';
import type { SlackClient } from '../slack/client';

/**
 * Standard contract for every AI-callable / Flow-callable action.
 *
 * Tools never receive credentials: they ask the context for an authenticated
 * client, which the API builds from the encrypted credential vault.
 */

export type ToolRisk = 'read' | 'write' | 'destructive' | 'production';

export interface ToolLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface ProjectRepositoryContext {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url?: string | null;
  settings: RepositorySettings;
}

export interface RepositorySettings {
  installCommand?: string;
  lintCommand?: string;
  testCommand?: string;
  buildCommand?: string;
  typecheckCommand?: string;
  sandboxImage?: string;
  ciWorkflow?: string;
  deployWorkflow?: string;
  [key: string]: unknown;
}

export interface ProjectEnvironmentContext {
  id: string;
  name: string;
  type: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  url?: string | null;
  healthCheckPath: string;
  smokeTests: SmokeTestDefinition[];
  requiresApproval: boolean;
  config: Record<string, unknown>;
}

export interface SmokeTestDefinition {
  name: string;
  method?: 'GET' | 'POST' | 'HEAD';
  path: string;
  expectStatus?: number;
  expectBodyContains?: string;
  body?: unknown;
}

export interface ProjectContext {
  id: string;
  name: string;
  key: string;
  slug: string;
  description?: string | null;
  settings: ProjectSettings;
  repository?: ProjectRepositoryContext | null;
  environments: ProjectEnvironmentContext[];
}

export interface ProjectSettings {
  jiraProjectKey?: string;
  jiraIssueType?: string;
  trelloBoardId?: string;
  trelloListId?: string;
  trelloDoneListId?: string;
  notionParentPageId?: string;
  slackChannel?: string;
  ticketProvider?: 'JIRA' | 'TRELLO';
  cicdProvider?: 'CUSTOM_DEVOPS' | 'GITHUB_ACTIONS';
  [key: string]: unknown;
}

/** Lazily-resolved, authenticated provider clients. */
export interface IntegrationClients {
  github(): Promise<GitHubClient>;
  jira(): Promise<JiraClient>;
  trello(): Promise<TrelloClient>;
  notion(): Promise<NotionClient>;
  cicd(): Promise<CiCdProvider>;
  slack(): Promise<SlackClient>;
  /** Providers connected for this organization. */
  connected(): Promise<IntegrationProvider[]>;
}

export interface ToolExecutionContext {
  organizationId: string;
  userId: string | null;
  project: ProjectContext | null;
  executionId?: string | null;
  stepKey?: string | null;
  /** Stable key for this logical action; adapters embed it for find-before-create. */
  idempotencyKey: string;
  mode: ExecutionMode;
  attempt: number;
  signal: AbortSignal;
  logger: ToolLogger;
  clients: IntegrationClients;
  /** Report progress (percent/message) for live UI updates. */
  progress(update: { percent?: number; message?: string }): void;
  /** Present when a polling tool is resumed (see ToolExecutionResult.continuation). */
  checkpoint?: unknown;
}

export interface ExternalResourceRef {
  provider: IntegrationProvider;
  type: ExternalResourceType;
  externalId: string;
  key?: string;
  title?: string;
  url?: string;
  status?: string;
  data?: Record<string, unknown>;
  /** Link to a parent resource created earlier in the same run (by externalId). */
  parentExternalId?: string;
}

export interface ArtifactRef {
  type: ArtifactType;
  title: string;
  content: string;
  contentType?: string;
  data?: Record<string, unknown>;
  url?: string;
}

export interface ToolExecutionResult<O = unknown> {
  output: O;
  /** One-line, human-readable result ("Created AUTH-142"). */
  summary: string;
  externalResources?: ExternalResourceRef[];
  artifacts?: ArtifactRef[];
  /** True when produced by a demo simulator rather than a real system. */
  simulated?: boolean;
  /**
   * Durable polling: when set, the engine persists `checkpoint` and re-invokes
   * the tool after `pollAfterMs` without consuming a retry attempt. Survives restarts.
   */
  continuation?: { pollAfterMs: number; checkpoint: unknown; message?: string };
}

export interface SdlcTool<I = unknown, O = unknown> {
  name: string;
  title: string;
  description: string;
  category: NodeCategory;
  provider: IntegrationProvider | null;
  /** Agent persona used in visualisations. */
  agent?: string;
  inputSchema: z.ZodType<I>;
  permission: Permission | ((input: I, ctx: ToolExecutionContext) => Permission);
  risk: ToolRisk;
  /** True if the tool changes external state; enables the idempotency ledger. */
  sideEffects: boolean;
  /** Approval-policy action key, e.g. "pr.merge", "deploy.production". */
  approvalAction?: string | ((input: I) => string | undefined);
  defaultTimeoutMs?: number;
  defaultRetry?: Partial<RetryPolicy>;
  /** Max total time for a polling tool across continuations. */
  maxPollDurationMs?: number;
  execute(input: I, ctx: ToolExecutionContext): Promise<ToolExecutionResult<O>>;
  /** Saga compensation. */
  compensate?(input: I, output: NoInfer<O>, ctx: ToolExecutionContext): Promise<{ summary: string }>;
  /** Demo-mode simulator. Outputs are always flagged simulated (links may be null). */
  simulate?(input: I, ctx: ToolExecutionContext): Promise<ToolExecutionResult<Simulated<NoInfer<O>>>>;
}

/** Simulated outputs share the real shape but may omit external links/ids. */
export type Simulated<O> = O extends object ? { [K in keyof O]: O[K] | null } : O;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySdlcTool = SdlcTool<any, any>;

/** Identity helper that preserves generic inference for tool definitions. */
export function defineTool<I, O>(tool: SdlcTool<I, O>): SdlcTool<I, O> {
  return tool;
}

/** Short, stable hash usable in external markers (labels, branch suffixes). */
export function shortHash(input: string, length = 10): string {
  // FNV-1a 64-bit folded into base36 — deterministic, dependency-free.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, length);
}

/** Marker embedded in created external resources for find-before-create idempotency. */
export function idempotencyMarker(ctx: Pick<ToolExecutionContext, 'idempotencyKey'>): string {
  return `fl-${shortHash(ctx.idempotencyKey, 12)}`;
}
