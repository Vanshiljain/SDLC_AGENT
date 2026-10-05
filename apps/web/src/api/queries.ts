import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import type { MeResponse, Paginated } from '@forgeline/shared';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from './client';
import type * as T from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

type Q = Record<string, string | number | boolean | null | undefined>;

/** Query keys are prefixed by resource so realtime events can invalidate whole families. */
export const qk = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  executions: (q?: Q) => ['executions', 'list', q ?? {}] as const,
  execution: (id: string) => ['executions', id] as const,
  executionLogs: (id: string) => ['executions', id, 'logs'] as const,
  approvals: (q?: Q) => ['approvals', 'list', q ?? {}] as const,
  approval: (id: string) => ['approvals', id] as const,
  workflows: ['workflows', 'list'] as const,
  workflow: (id: string) => ['workflows', id] as const,
  templates: ['workflows', 'templates'] as const,
  tools: ['tools'] as const,
  commands: ['commands'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversations', id] as const,
  integrations: ['integrations'] as const,
  providers: ['integrations', 'providers'] as const,
  deployments: (q?: Q) => ['deployments', 'list', q ?? {}] as const,
  environments: ['deployments', 'environments'] as const,
  graph: (q?: Q) => ['graph', q ?? {}] as const,
  knowledge: (q?: Q) => ['knowledge', 'documents', q ?? {}] as const,
  knowledgeStats: ['knowledge', 'stats'] as const,
  agents: ['agents'] as const,
  agentRuns: (q?: Q) => ['agents', 'runs', q ?? {}] as const,
  notifications: ['notifications'] as const,
  unread: ['notifications', 'unread'] as const,
  audit: (q?: Q) => ['audit', q ?? {}] as const,
  observability: ['observability'] as const,
  org: ['org'] as const,
  members: ['org', 'members'] as const,
  teams: ['org', 'teams'] as const,
  reviews: (q?: Q) => ['code-review', q ?? {}] as const,
  review: (id: string) => ['code-review', id] as const,
  qa: (q?: Q) => ['qa', q ?? {}] as const,
  documents: (q?: Q) => ['documents', q ?? {}] as const,
  document: (id: string) => ['documents', id] as const,
  tasks: (q?: Q) => ['tasks', q ?? {}] as const,
  codegen: (q?: Q) => ['code-generation', q ?? {}] as const,
};

function useGet<TData>(key: QueryKey, path: string, query?: Q, options: Partial<UseQueryOptions<TData>> = {}) {
  return useQuery<TData>({ queryKey: key, queryFn: ({ signal }) => api.get<TData>(path, query, signal), ...options });
}

export const useMe = (enabled = true) => useGet<MeResponse>(qk.me, '/auth/me', undefined, { enabled, staleTime: 60_000 });
export const useDashboard = () => useGet<T.DashboardData>(qk.dashboard, '/dashboard', undefined, { refetchInterval: 60_000 });
export const useProjects = () => useGet<T.ProjectSummary[]>(qk.projects, '/projects');
export const useProject = (id: string) => useGet<T.ProjectDetail>(qk.project(id), `/projects/${id}`);
export const useExecutions = (q: Q) => useGet<Paginated<T.ExecutionListItem>>(qk.executions(q), '/workflow-executions', q, { placeholderData: keepPreviousData });
export const useExecution = (id: string) => useGet<T.ExecutionDetail>(qk.execution(id), `/workflow-executions/${id}`);
export const useExecutionLogs = (id: string) => useGet<T.ExecutionLog[]>(qk.executionLogs(id), `/workflow-executions/${id}/logs`, { limit: 2000 });
export const useApprovals = (q: Q) => useGet<Paginated<T.Approval>>(qk.approvals(q), '/approvals', q, { placeholderData: keepPreviousData });
export const useApproval = (id: string) => useGet<T.Approval>(qk.approval(id), `/approvals/${id}`);
export const useWorkflows = () => useGet<T.Workflow[]>(qk.workflows, '/workflows');
export const useWorkflow = (id: string, enabled = true) => useGet<T.Workflow>(qk.workflow(id), `/workflows/${id}`, undefined, { enabled });
export const useTemplates = () => useGet<T.FlowTemplate[]>(qk.templates, '/workflows/templates', undefined, { staleTime: 10 * 60_000 });
export const useTools = () => useGet<T.ToolInfo[]>(qk.tools, '/tools', undefined, { staleTime: 10 * 60_000 });
export const useCommands = () => useGet<T.CommandCatalog>(qk.commands, '/commands', undefined, { staleTime: 10 * 60_000 });
export const useConversations = () => useGet<T.Conversation[]>(qk.conversations, '/conversations');
export const useConversation = (id: string | null) => useGet<T.ConversationDetail>(qk.conversation(id ?? 'none'), `/conversations/${id}`, undefined, { enabled: Boolean(id) });
export const useIntegrations = () => useGet<T.Integration[]>(qk.integrations, '/integrations');
export const useProviders = () => useGet<T.ProviderInfo[]>(qk.providers, '/integrations/providers', undefined, { staleTime: 10 * 60_000 });
export const useDeployments = (q: Q) => useGet<Paginated<T.Deployment>>(qk.deployments(q), '/deployments', q, { placeholderData: keepPreviousData });
export const useEnvironmentBoard = () => useGet<T.EnvironmentBoardItem[]>(qk.environments, '/deployments/environments');
export const useGraph = (q: Q) => useGet<T.EngineeringGraph>(qk.graph(q), '/graph', q);
export const useKnowledge = (q: Q) => useGet<Paginated<T.KnowledgeDocument>>(qk.knowledge(q), '/knowledge/documents', q, { placeholderData: keepPreviousData });
export const useKnowledgeStats = () => useGet<T.KnowledgeStats>(qk.knowledgeStats, '/knowledge/stats');
export const useAgents = () => useGet<T.AgentInfo[]>(qk.agents, '/agents');
export const useAgentRuns = (q: Q) => useGet<Paginated<T.AgentRun>>(qk.agentRuns(q), '/agents/runs', q, { placeholderData: keepPreviousData });
export const useNotifications = () => useGet<T.Notification[]>(qk.notifications, '/notifications');
export const useUnreadCount = () => useGet<{ count: number }>(qk.unread, '/notifications/unread-count', undefined, { refetchInterval: 120_000 });
export const useAudit = (q: Q) => useGet<Paginated<T.AuditEntry>>(qk.audit(q), '/audit', q, { placeholderData: keepPreviousData });
export const useObservability = () => useGet<T.ObservabilitySummary>(qk.observability, '/observability/summary');
export const useOrganization = () => useGet<T.Organization>(qk.org, '/organizations/current');
export const useMembers = () => useGet<{ members: T.Member[]; invitations: T.Invitation[] }>(qk.members, '/organizations/current/members');
export const useTeams = () => useGet<T.Team[]>(qk.teams, '/organizations/current/teams');
export const useReviews = (q: Q) => useGet<Paginated<T.CodeReviewSummary>>(qk.reviews(q), '/code-review', q, { placeholderData: keepPreviousData });
export const useReview = (id: string) => useGet<T.CodeReviewDetail>(qk.review(id), `/code-review/${id}`);
export const useQaRuns = (q: Q) => useGet<Paginated<T.QaRun> & { summary: Record<string, number> }>(qk.qa(q), '/qa/runs', q, { placeholderData: keepPreviousData });
export const useDocuments = (q: Q) => useGet<Paginated<T.DocumentSummary>>(qk.documents(q), '/documents', q, { placeholderData: keepPreviousData });
export const useDocument = (id: string) => useGet<T.DocumentDetail>(qk.document(id), `/documents/${id}`);
export const useTasks = (q: Q) => useGet<Paginated<T.Task>>(qk.tasks(q), '/tasks', q, { placeholderData: keepPreviousData });
export const useCodeGenerations = (q: Q) => useGet<Paginated<T.CodeGenerationSummary>>(qk.codegen(q), '/code-generation', q, { placeholderData: keepPreviousData });

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars, TRes = unknown>(
  fn: (vars: TVars) => Promise<TRes>,
  opts: { success?: string | ((res: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (res: TRes, vars: TVars) => void; silent?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TVars>({
    mutationFn: fn,
    onSuccess: (res, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(res) : opts.success);
      opts.invalidate?.forEach((key) => void qc.invalidateQueries({ queryKey: key }));
      opts.onSuccess?.(res, vars);
    },
    onError: (err) => {
      if (!opts.silent) toast.error(errorMessage(err));
    },
  });
}
