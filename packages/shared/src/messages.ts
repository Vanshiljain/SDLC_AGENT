import type { ArtifactType, ExecutionStatus, StepStatus } from './enums';

/**
 * Rich chat message parts. The assistant's messages are a list of parts so the
 * UI can render interactive cards (runs, approvals, reviews, deployments)
 * rather than plain text.
 */
export type MessagePart =
  | TextPart
  | RunCardPart
  | FlowProposalPart
  | ToolCallPart
  | ArtifactPart
  | ApprovalPart
  | EntityPart
  | SourcesPart
  | ErrorPart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface RunCardPart {
  type: 'run';
  executionId: string;
  title: string;
  status: ExecutionStatus;
  mode: 'LIVE' | 'DEMO';
  steps: { key: string; name: string; status: StepStatus; agent?: string | null }[];
}

export interface FlowProposalStep {
  key: string;
  name: string;
  tool?: string;
  type: string;
  dependsOn: string[];
  requiresApproval: boolean;
  agent?: string;
}

export interface FlowProposalPart {
  type: 'flow_proposal';
  proposalId: string;
  title: string;
  summary: string;
  projectId: string | null;
  steps: FlowProposalStep[];
  approvalsRequired: string[];
  missingIntegrations: string[];
  /** proposed | started | dismissed */
  state: 'proposed' | 'started' | 'dismissed';
  executionId?: string;
  mode: 'LIVE' | 'DEMO';
}

export interface ToolCallPart {
  type: 'tool_call';
  callId: string;
  tool: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  summary?: string;
}

export interface ArtifactPart {
  type: 'artifact';
  artifactId: string;
  artifactType: ArtifactType;
  title: string;
  preview?: string;
}

export interface ApprovalPart {
  type: 'approval';
  approvalId: string;
  title: string;
  riskLevel: string;
}

export interface EntityPart {
  type: 'entity';
  kind: 'deployment' | 'code_review' | 'qa_run' | 'code_generation' | 'document' | 'task';
  id: string;
  title: string;
}

export interface SourcesPart {
  type: 'sources';
  sources: { documentId: string; title: string; score: number; sourceType: string; url?: string | null }[];
}

export interface ErrorPart {
  type: 'error';
  message: string;
  retryable: boolean;
}

/** Page context sent by the global assistant so the agent knows what the user sees. */
export interface PageContext {
  route: string;
  title?: string;
  entity?: {
    kind:
      | 'project'
      | 'execution'
      | 'workflow'
      | 'deployment'
      | 'code_review'
      | 'qa_run'
      | 'approval'
      | 'task'
      | 'document'
      | 'repository';
    id: string;
    label?: string;
  };
  projectId?: string;
}
