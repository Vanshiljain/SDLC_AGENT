import type {
  ApprovalStatus,
  DeploymentStatus,
  EnvironmentType,
  ExecutionMode,
  ExecutionStatus,
  HealthStatus,
  IntegrationAuthType,
  IntegrationProvider,
  IntegrationStatus,
  MessagePart,
  OrgRole,
  ProjectRole,
  RiskLevel,
  StepStatus,
  TriggerSource,
  WorkflowDefinition,
  WorkflowStatus,
} from '@forgeline/shared';

/** Response models for the Forgeline REST API (mirrors the server's serializers). */

export interface UserRef {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
}
export interface ProjectRef {
  id: string;
  name: string;
  key: string;
}

// ───────── Projects ─────────
export interface RepositorySettings {
  installCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  testCommand?: string;
  buildCommand?: string;
  sandboxImage?: string;
  ciWorkflow?: string;
  deployWorkflow?: string;
}
export interface Repository {
  id: string;
  projectId: string;
  integrationId: string | null;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string | null;
  language: string | null;
  settings: RepositorySettings;
  lastIndexedAt: string | null;
}
export interface SmokeTest {
  name: string;
  method?: 'GET' | 'POST' | 'HEAD';
  path: string;
  expectStatus?: number;
  expectBodyContains?: string;
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  type: EnvironmentType;
  url: string | null;
  healthCheckPath: string | null;
  smokeTests: SmokeTest[];
  requiresApproval: boolean;
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
  approvalPolicy?: Record<string, 'required' | 'auto'>;
}
export interface ProjectHealth {
  score: number | null;
  status: 'healthy' | 'at_risk' | 'critical' | 'unknown';
  runs14d: number;
  successRate: number | null;
  pendingApprovals: number;
  lastQa: { status: string; passed: number; failed: number; createdAt: string } | null;
  deployments: { environment: string; type: EnvironmentType; status: DeploymentStatus; version: string; at: string; simulated: boolean }[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  key: string;
  slug: string;
  description: string | null;
  settings: ProjectSettings;
  team: { id: string; name: string } | null;
  repositories: Pick<Repository, 'id' | 'fullName' | 'defaultBranch' | 'language'>[];
  environments: Pick<Environment, 'id' | 'name' | 'type' | 'url'>[];
  _count: { executions: number; tasks: number };
  health: ProjectHealth;
  createdAt: string;
}
export interface ProjectDetail extends Omit<ProjectSummary, 'repositories' | 'environments' | '_count' | 'health'> {
  repositories: Repository[];
  environments: Environment[];
  members: { id: string; userId: string; role: ProjectRole; user: UserRef }[];
  latestDeployments: Deployment[];
}

// ───────── Runs ─────────
export interface StepError {
  kind?: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}
export interface ExecutionStep {
  id: string;
  executionId: string;
  stepKey: string;
  name: string;
  type: string;
  tool: string | null;
  agent: string | null;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  iteration: number;
  position: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: StepError | null;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  polls: number;
  createdAt: string;
}
export interface ExecutionListItem {
  id: string;
  title: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  template: string | null;
  triggerSource: TriggerSource;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: { message: string; steps?: string[] } | null;
  project: ProjectRef | null;
  triggeredBy: UserRef | null;
  steps: Pick<ExecutionStep, 'id' | 'stepKey' | 'name' | 'status' | 'agent'>[];
  _count?: { approvals?: number; artifacts?: number };
}
export interface ArtifactSummary {
  id: string;
  type: string;
  title: string;
  stepId: string | null;
  contentType: string;
  url: string | null;
  createdAt: string;
  version: number;
}
export interface Artifact extends ArtifactSummary {
  content: string | null;
  data: unknown;
  executionId: string | null;
}
export interface ExternalResource {
  id: string;
  type: string;
  provider: string;
  key: string | null;
  url: string | null;
  title: string | null;
  simulated: boolean;
  createdAt: string;
}
export interface ExecutionDetail extends Omit<ExecutionListItem, 'steps'> {
  organizationId: string;
  projectId: string | null;
  workflowId: string | null;
  conversationId: string | null;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  revision: number;
  pausedAt: string | null;
  cancelledAt: string | null;
  workflow: { id: string; name: string } | null;
  steps: ExecutionStep[];
  approvals: Approval[];
  artifacts: ArtifactSummary[];
  externalResources: ExternalResource[];
  deployments: (Deployment & { environment: { name: string; type: EnvironmentType } })[];
  codeReviews: (Omit<CodeReviewDetail, 'project' | 'repository'>)[];
  qaRuns: Pick<QaRun, 'id' | 'type' | 'status' | 'title' | 'total' | 'passed' | 'failed' | 'skipped' | 'durationMs' | 'simulated' | 'createdAt'>[];
  codeGenerations: { id: string; status: string; branch: string; files: { path: string; action: string; explanation?: string }[]; commitSha: string | null; prUrl: string | null; prNumber: number | null; iterations: number; simulated: boolean; validation: { passed: boolean | null; ran: boolean; summary: string; checks: { name: string; status: string; command: string; exitCode: number | null; durationMs: number; excerpt: string | null }[] } | null }[];
  agentRuns: (AgentRun & { agent: { key: string; name: string; kind: string } })[];
  toolExecutions: { id: string; stepId: string | null; tool: string; status: string; attempt: number; durationMs: number | null; startedAt: string; completedAt: string | null; simulated: boolean; externalUrl: string | null; error: StepError | null }[];
  usage: { totalTokens: number; llmCalls: number };
}
export interface ExecutionLog {
  id: string;
  executionId: string;
  stepId: string | null;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

// ───────── Approvals ─────────
export interface ApprovalEvidence {
  ci?: { status: string; detail?: string | null };
  qa?: { status: string; passed?: number; failed?: number };
  review?: { status: string; critical?: number; high?: number; security?: string };
  changes?: { files: number; items: string[]; summary?: string | null };
  migrations?: boolean;
  rollbackReady?: boolean;
  simulated?: boolean;
  environment?: string | null;
  action?: string;
}
export interface ApprovalContext {
  risk?: { level: RiskLevel; source: string; summary: string; factors: { factor: string; impact: 'positive' | 'negative' | 'neutral' | string }[]; mitigations: string[]; recommendation: string };
  evidence?: ApprovalEvidence;
  ticket?: { key: string; url: string | null; summary: string | null } | null;
  pullRequest?: { number: number | null; url: string | null; title: string | null } | null;
  environment?: string | null;
  version?: string | null;
  runTitle?: string;
  tool?: string;
  input?: Record<string, unknown>;
}
export interface Approval {
  id: string;
  projectId: string | null;
  executionId: string | null;
  executionStepId: string | null;
  title: string;
  description: string | null;
  action: string;
  riskLevel: RiskLevel;
  context: ApprovalContext;
  status: ApprovalStatus;
  requiredPermission: string;
  allowSelfApproval: boolean;
  requestedById: string | null;
  decidedById: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  execution?: { id: string; title: string; status: ExecutionStatus; mode: ExecutionMode; project: ProjectRef | null } | null;
  step?: { id: string; stepKey: string; name: string; tool: string | null } | null;
  requestedBy?: UserRef | null;
  decidedBy?: UserRef | null;
  canDecide?: boolean;
  cannotDecideReason?: string | null;
}

// ───────── Deployments ─────────
export interface ProbeResult {
  name: string;
  status: 'passed' | 'failed';
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
}
export interface Deployment {
  id: string;
  projectId: string;
  environmentId: string;
  executionId: string | null;
  version: string;
  ref: string | null;
  commitSha: string | null;
  status: DeploymentStatus;
  provider: string;
  externalUrl: string | null;
  healthChecks: ProbeResult[];
  smokeTests: ProbeResult[];
  simulated: boolean;
  error: { message?: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  environment?: { id?: string; name: string; type: EnvironmentType };
  project?: { id?: string; name: string; key: string };
}
export interface EnvironmentBoardItem {
  id: string;
  name: string;
  type: EnvironmentType;
  url: string | null;
  requiresApproval: boolean;
  project: ProjectRef;
  current: Deployment | null;
  recent: Deployment[];
}

// ───────── Workflows ─────────
export interface WorkflowTrigger {
  id: string;
  type: 'MANUAL' | 'WEBHOOK' | 'SCHEDULE' | 'EVENT';
  config: Record<string, unknown>;
  isEnabled: boolean;
  lastFiredAt?: string | null;
}
export interface Workflow {
  id: string;
  projectId: string | null;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  version: number;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef | null;
  triggers: WorkflowTrigger[];
  _count?: { executions: number };
}
export interface FlowTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  stepCount: number;
  inputs: Record<string, { type: string; required?: boolean; default?: unknown; description?: string }>;
  tools: string[];
  providers: string[];
  definition: WorkflowDefinition;
}
export interface ValidationIssue {
  path: string;
  message: string;
  stepKey?: string;
}
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  provider: string | null;
  agent: string | null;
  risk: 'read' | 'write' | 'destructive' | string;
  sideEffects: boolean;
  permission: string;
  approvalAction: string | null;
  supportsDemo: boolean;
  polling: boolean;
  inputSchema: { type?: string; properties?: Record<string, { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown }>; required?: string[] };
}

// ───────── Commands ─────────
export interface CommandInput {
  name: string;
  label: string;
  type: 'string' | 'text' | 'project' | 'environment' | 'boolean' | 'select' | string;
  required: boolean;
  placeholder?: string;
  options?: string[];
  default?: unknown;
}
export interface CommandDef {
  id: string;
  title: string;
  description: string;
  category: string;
  template: string;
  permission: string;
  inputs: CommandInput[];
  keywords: string[];
}
export interface CommandCatalog {
  commands: CommandDef[];
  pages: { route: string; title: string; keywords: string[] }[];
}
export interface CommandRoute {
  kind: 'command' | 'navigate' | 'chat';
  commandId: string | null;
  route: string | null;
  inputs: { name: string; value: unknown }[];
  confidence: number;
  explanation: string;
  projectId: string | null;
  source: 'ai' | 'keyword';
}

// ───────── Conversations ─────────
export interface Message {
  id: string;
  conversationId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  content: string;
  parts: MessagePart[];
  status: 'complete' | 'streaming' | 'error' | 'cancelled' | 'interrupted';
  executionId: string | null;
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
  project?: ProjectRef | null;
}
export interface ConversationDetail extends Conversation {
  messages: Message[];
}

// ───────── Integrations ─────────
export interface CredentialField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'email' | string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}
export interface ProviderInfo {
  provider: IntegrationProvider;
  name: string;
  description: string;
  capabilities: string[];
  authMethods: { type: IntegrationAuthType; label: string; available: boolean; unavailableReason?: string; fields: CredentialField[] }[];
  docsUrl: string;
  webhookSupport: boolean;
}
export interface Integration {
  id: string;
  provider: IntegrationProvider;
  name: string;
  status: IntegrationStatus;
  authType: IntegrationAuthType;
  scopes: string[];
  externalAccountName: string | null;
  config: Record<string, unknown>;
  healthStatus: HealthStatus;
  healthMessage: string | null;
  lastHealthCheckAt: string | null;
  createdAt: string;
}

// ───────── Org ─────────
export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  isDemo: boolean;
  settings: { fourEyesProduction: boolean; defaultTicketProvider: string; logRetentionDays: number };
}
export interface Member {
  id: string;
  role: OrgRole;
  joinedAt: string;
  user: UserRef;
}
export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  createdAt: string;
}
export interface Team {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  members: { id: string; userId: string; role: string; user: UserRef }[];
  _count: { projects: number };
}

// ───────── Dashboard ─────────
export interface DashboardData {
  headline: { activeRuns: number; pendingApprovals: number; failedRuns7d: number; successRate30d: number | null; deployments7d: number; tokens7d: number };
  activeRuns: { id: string; title: string; status: ExecutionStatus; mode: ExecutionMode; startedAt: string | null; project: ProjectRef | null; steps: { stepKey: string; name: string; status: StepStatus; agent: string | null; summary: string | null }[] }[];
  recentRuns: { id: string; title: string; status: ExecutionStatus; mode: ExecutionMode; createdAt: string; completedAt: string | null; template: string | null; project: { name: string; key: string } | null }[];
  failedRuns: { id: string; title: string; error: { message: string } | null; completedAt: string; project: { name: string } | null }[];
  pendingApprovals: { id: string; title: string; action: string; riskLevel: RiskLevel; createdAt: string; context: ApprovalContext; execution: { id: string; title: string; mode: ExecutionMode } | null }[];
  deployments: (Deployment & { environment: { name: string; type: EnvironmentType }; project: { name: string; key: string } })[];
  qa: { byStatus: Record<string, number>; runs: number; passed: number; failed: number };
  reviews: { count: number; critical: number; high: number; medium: number; low: number };
  integrations: Pick<Integration, 'id' | 'provider' | 'name' | 'status' | 'healthStatus' | 'healthMessage' | 'lastHealthCheckAt'>[];
  agentActivity: { id: string; task: string; status: string; summary: string | null; startedAt: string; durationMs: number | null; totalTokens: number; executionId: string | null; agent: { key: string; name: string; kind: string } }[];
  projects: { id: string; name: string; key: string; health: ProjectHealth }[];
}

// ───────── SDLC records ─────────
export interface ReviewFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category: string;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
}
export interface CodeReviewSummary {
  id: string;
  title: string;
  status: string;
  verdict: string | null;
  riskLevel: RiskLevel | null;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  prNumber: number | null;
  prUrl: string | null;
  postedToProvider: boolean;
  simulated: boolean;
  createdAt: string;
  executionId: string | null;
  dimensions: Record<string, string>;
  project: ProjectRef;
}
export interface CodeReviewDetail extends CodeReviewSummary {
  summary: string | null;
  findings: ReviewFinding[];
  repository: { fullName: string; url: string | null } | null;
}
export interface QaRun {
  id: string;
  title: string;
  type: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  ref: string | null;
  simulated: boolean;
  createdAt: string;
  executionId: string | null;
  project: ProjectRef;
  testCases?: { id: string; title: string; type: string; priority: string; expected: string; steps?: string[]; status?: string }[];
  output?: string | null;
  failures?: { name?: string; message?: string; check?: string; output?: string }[];
  analysis?: { summary?: string; rootCause?: string; category?: string } | null;
  command?: string | null;
}
export interface DocumentSummary {
  id: string;
  title: string;
  type: string;
  externalProvider: string | null;
  externalUrl: string | null;
  version: number;
  updatedAt: string;
  executionId: string | null;
  project: ProjectRef | null;
}
export interface DocumentDetail extends DocumentSummary {
  content: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  externalProvider: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
  project?: ProjectRef | null;
  assignee?: UserRef | null;
}
export interface CodeGenerationSummary {
  id: string;
  requirement: string;
  status: string;
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  prUrl: string | null;
  prNumber: number | null;
  iterations: number;
  simulated: boolean;
  createdAt: string;
  executionId: string | null;
  project: ProjectRef;
}

// ───────── Knowledge ─────────
export interface KnowledgeDocument {
  id: string;
  title: string;
  sourceType: string;
  sourceRef: string;
  documentType: string;
  url: string | null;
  status: string;
  chunkCount: number;
  tokenCount: number;
  error: string | null;
  projectId: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
  content?: string | null;
  project?: ProjectRef | null;
}
export interface KnowledgeStats {
  embeddingsAvailable: boolean;
  vectorStore: { ok: boolean; message: string };
  embeddingModel: string;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  chunks: number;
  tokens: number;
}
export interface KnowledgeHit {
  documentId: string;
  title: string;
  content: string;
  score: number;
  sourceType: string;
  url?: string | null;
  location?: string | null;
}

// ───────── Agents / observability / audit ─────────
export interface AgentInfo {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: string;
  modelRole: string;
  tools: string[];
  isEnabled: boolean;
  stats30d: { runs: number; successRate: number | null; tokens: number; avgDurationMs: number | null };
  active: { id: string; task: string; startedAt: string; executionId: string | null; conversationId: string | null }[];
}
export interface AgentRun {
  id: string;
  agentId: string;
  agent?: { key: string; name: string; kind: string };
  task: string;
  status: string;
  summary: string | null;
  model: string | null;
  totalTokens: number;
  llmCalls: number;
  durationMs: number | null;
  executionId: string | null;
  conversationId: string | null;
  startedAt: string;
  completedAt: string | null;
  error?: { message?: string } | null;
}
export interface ObservabilitySummary {
  windowDays: number;
  runsDaily: { day: string; status: string; count: number }[];
  tokensByModel: { model: string; runs: number; calls: number; prompt: number; completion: number; total: number }[];
  agents: { agent: string; runs: number; failed: number; tokens: number; avgMs: number | null }[];
  tools: { tool: string; total: number; failed: number; errorRate: number; avgMs: number | null; p95Ms: number | null }[];
  stepLatency: { tool: string; p50: number | null; p95: number | null; samples: number }[];
  errorKinds: { kind: string; count: number }[];
}
export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: 'USER' | 'AGENT' | 'SYSTEM' | string;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  executionId: string | null;
  tool: string | null;
  status: 'SUCCESS' | 'FAILURE' | 'DENIED';
  input: unknown;
  output: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
  actor: UserRef | null;
}
export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

// ───────── Graph ─────────
export interface GraphNode {
  id: string;
  type: string;
  label: string;
  sublabel?: string | null;
  link?: string | null;
  url?: string | null;
  status?: string | null;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string | null;
}
export interface EngineeringGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
