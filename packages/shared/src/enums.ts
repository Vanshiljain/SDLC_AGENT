/**
 * Domain enums shared by the API, workers and web app.
 * These mirror the Prisma enums in packages/database/prisma/schema.prisma;
 * apps/api has a test asserting they stay in sync.
 */

const tuple = <T extends string>(...values: T[]) => values;

export const ORG_ROLES = tuple('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = tuple('MAINTAINER', 'DEVELOPER', 'VIEWER');
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const INTEGRATION_PROVIDERS = tuple(
  'GITHUB',
  'GITHUB_ACTIONS',
  'JIRA',
  'TRELLO',
  'NOTION',
  'CUSTOM_DEVOPS',
  'SLACK',
);
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = tuple('CONNECTED', 'DISCONNECTED', 'ERROR', 'EXPIRED', 'PENDING');
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_AUTH_TYPES = tuple('OAUTH2', 'API_TOKEN', 'BASIC', 'WEBHOOK_URL', 'HMAC');
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number];

export const HEALTH_STATUSES = tuple('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN');
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const EXECUTION_STATUSES = tuple(
  'PENDING',
  'RUNNING',
  'WAITING_APPROVAL',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
);
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'COMPENSATED',
];

export const STEP_STATUSES = tuple(
  'PENDING',
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'RETRY_SCHEDULED',
  'REPAIRING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'COMPENSATED',
);
export type StepStatus = (typeof STEP_STATUSES)[number];
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'COMPENSATED',
];

export const EXECUTION_MODES = tuple('LIVE', 'DEMO');
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const TRIGGER_SOURCES = tuple(
  'CHAT',
  'MANUAL',
  'COMMAND_PALETTE',
  'WEBHOOK',
  'SCHEDULE',
  'API',
  'ASSISTANT',
);
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TRIGGER_TYPES = tuple('MANUAL', 'WEBHOOK', 'SCHEDULE', 'EVENT');
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WORKFLOW_STATUSES = tuple('DRAFT', 'ACTIVE', 'ARCHIVED');
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const APPROVAL_STATUSES = tuple('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const RISK_LEVELS = tuple('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ENVIRONMENT_TYPES = tuple('DEVELOPMENT', 'STAGING', 'PRODUCTION');
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const DEPLOYMENT_STATUSES = tuple(
  'PENDING',
  'AWAITING_APPROVAL',
  'IN_PROGRESS',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
);
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const QA_TEST_TYPES = tuple('UNIT', 'INTEGRATION', 'API', 'E2E', 'REGRESSION', 'SMOKE', 'LINT', 'STATIC_ANALYSIS');
export type QATestType = (typeof QA_TEST_TYPES)[number];

export const QA_RUN_STATUSES = tuple('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'SKIPPED');
export type QARunStatus = (typeof QA_RUN_STATUSES)[number];

export const CODE_GENERATION_STATUSES = tuple(
  'PLANNING',
  'GENERATING',
  'VALIDATING',
  'READY',
  'COMMITTED',
  'FAILED',
);
export type CodeGenerationStatus = (typeof CODE_GENERATION_STATUSES)[number];

export const REVIEW_VERDICTS = tuple('APPROVE', 'REQUEST_CHANGES', 'COMMENT');
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_STATUSES = tuple('RUNNING', 'COMPLETED', 'FAILED');
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FINDING_SEVERITIES = tuple('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = tuple(
  'CORRECTNESS',
  'SECURITY',
  'PERFORMANCE',
  'MAINTAINABILITY',
  'ARCHITECTURE',
  'ERROR_HANDLING',
  'TESTS',
  'TYPES',
  'API_DESIGN',
  'DATABASE',
  'CONCURRENCY',
  'AUTH',
);
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const ARTIFACT_TYPES = tuple(
  'SPECIFICATION',
  'IMPLEMENTATION_PLAN',
  'WORKFLOW_PLAN',
  'ARCHITECTURE_DIAGRAM',
  'CODE_DIFF',
  'TEST_REPORT',
  'REVIEW_REPORT',
  'DEPLOYMENT_REPORT',
  'INCIDENT_REPORT',
  'DOCUMENTATION',
  'PR_SUMMARY',
  'TICKET',
  'RISK_ASSESSMENT',
  'LOG',
);
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const DOCUMENT_TYPES = tuple('SPECIFICATION', 'ADR', 'RUNBOOK', 'API', 'GUIDE', 'RELEASE_NOTES', 'OTHER');
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const TASK_STATUSES = tuple('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED');
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = tuple('LOWEST', 'LOW', 'MEDIUM', 'HIGH', 'HIGHEST');
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const KNOWLEDGE_SOURCE_TYPES = tuple(
  'UPLOAD',
  'GITHUB',
  'JIRA',
  'NOTION',
  'URL',
  'EXECUTION',
  'SPECIFICATION',
  'API_DOC',
  'GUIDELINE',
  'ARCHITECTURE',
);
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const KNOWLEDGE_STATUSES = tuple('PENDING', 'PROCESSING', 'INDEXED', 'FAILED');
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const MESSAGE_ROLES = tuple('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const AGENT_KINDS = tuple(
  'ORCHESTRATOR',
  'PLANNER',
  'ARCHITECT',
  'CODER',
  'REVIEWER',
  'QA',
  'DOCS',
  'RELEASE',
);
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_RUN_STATUSES = tuple('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TOOL_EXECUTION_STATUSES = tuple('RUNNING', 'SUCCEEDED', 'FAILED');
export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = tuple('USER', 'AGENT', 'SYSTEM', 'WEBHOOK');
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_STATUSES = tuple('SUCCESS', 'FAILURE', 'DENIED');
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const LOG_LEVELS = tuple('DEBUG', 'INFO', 'WARN', 'ERROR');
export type LogLevel = (typeof LOG_LEVELS)[number];

export const EXTERNAL_RESOURCE_TYPES = tuple(
  'JIRA_ISSUE',
  'TRELLO_CARD',
  'GITHUB_REPOSITORY',
  'GITHUB_BRANCH',
  'GITHUB_COMMIT',
  'GITHUB_PULL_REQUEST',
  'GITHUB_ISSUE',
  'CI_RUN',
  'NOTION_PAGE',
  'DEPLOYMENT',
  'CONTAINER_IMAGE',
  'BUILD_ARTIFACT',
);
export type ExternalResourceType = (typeof EXTERNAL_RESOURCE_TYPES)[number];

export const NOTIFICATION_TYPES = tuple(
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'WORKFLOW_COMPLETED',
  'WORKFLOW_FAILED',
  'DEPLOYMENT',
  'MENTION',
  'INTEGRATION',
  'SYSTEM',
);
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
