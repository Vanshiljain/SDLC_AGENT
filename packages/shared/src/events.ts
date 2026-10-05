import type {
  ApprovalStatus,
  DeploymentStatus,
  ExecutionStatus,
  LogLevel,
  StepStatus,
} from './enums';

/** Realtime/domain event names. Dot-separated, lower case. */
export const EVENT_TYPES = [
  'workflow.started',
  'workflow.status',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'workflow.paused',
  'workflow.resumed',
  'workflow.step.queued',
  'workflow.step.started',
  'workflow.step.progress',
  'workflow.step.completed',
  'workflow.step.failed',
  'workflow.step.skipped',
  'workflow.step.retrying',
  'workflow.step.repairing',
  'workflow.step.waiting_approval',
  'workflow.log',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'deployment.started',
  'deployment.progress',
  'deployment.completed',
  'deployment.failed',
  'deployment.rolled_back',
  'code.generated',
  'code.reviewed',
  'qa.started',
  'qa.completed',
  'agent.run.started',
  'agent.run.completed',
  'agent.message.delta',
  'agent.message.completed',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.activity',
  'notification.created',
  'integration.status',
  'knowledge.document.status',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent<TData = Record<string, unknown>> {
  id: string;
  type: EventType;
  organizationId: string;
  projectId?: string | null;
  executionId?: string | null;
  conversationId?: string | null;
  /** If set, only this user receives the event (e.g. personal notifications). */
  userId?: string | null;
  occurredAt: string;
  data: TData;
}

export interface StepEventData {
  stepId: string;
  stepKey: string;
  name: string;
  status: StepStatus;
  attempt: number;
  iteration: number;
  tool?: string | null;
  summary?: string | null;
  error?: { message: string; kind?: string } | null;
  durationMs?: number | null;
  progress?: { percent?: number; message?: string } | null;
}

export interface ExecutionStatusEventData {
  status: ExecutionStatus;
  title: string;
  progress: { completed: number; total: number };
  error?: { message: string } | null;
}

export interface LogEventData {
  stepId?: string | null;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ApprovalEventData {
  approvalId: string;
  title: string;
  status: ApprovalStatus;
  riskLevel: string;
  executionId: string;
}

export interface DeploymentEventData {
  deploymentId: string;
  environment: string;
  version: string;
  status: DeploymentStatus;
  message?: string;
  simulated: boolean;
}

export interface AgentDeltaEventData {
  messageId: string;
  delta: string;
}

export interface AgentActivityEventData {
  agentRunId: string;
  agent: string;
  activity: string;
  tool?: string;
  status: 'running' | 'completed' | 'failed';
}

/** Socket.IO room naming. */
export const rooms = {
  org: (organizationId: string) => `org:${organizationId}`,
  user: (userId: string) => `user:${userId}`,
  execution: (executionId: string) => `execution:${executionId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
} as const;

/** Client → server socket messages. */
export interface SocketSubscribeMessage {
  executionId?: string;
  conversationId?: string;
}
