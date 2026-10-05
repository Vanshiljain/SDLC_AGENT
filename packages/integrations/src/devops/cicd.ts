/**
 * Provider-neutral CI/CD contract. Forgeline's deployment and pipeline logic
 * only depends on this interface, so new CI/CD systems plug in without
 * touching workflows (requirement: do not couple to GitHub Actions).
 */

export const PIPELINE_STAGES = ['lint', 'build', 'test', 'security_scan', 'artifact', 'container_build', 'image_scan'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StageResult {
  stage: PipelineStage | string;
  status: RunStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  summary?: string | null;
  url?: string | null;
}

export interface PipelineRequest {
  project: string;
  repository?: string;
  ref: string;
  commitSha?: string;
  stages: PipelineStage[];
  idempotencyKey: string;
  variables?: Record<string, string>;
}

export interface PipelineRun {
  id: string;
  status: RunStatus;
  url?: string | null;
  stages: StageResult[];
  /** Produced build artifact / container image references. */
  artifact?: { ref: string; digest?: string | null } | null;
  image?: { ref: string; digest?: string | null; vulnerabilities?: { critical: number; high: number; medium: number; low: number } } | null;
}

export interface DeployRequest {
  project: string;
  environment: string;
  environmentType: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  version: string;
  ref?: string;
  commitSha?: string;
  artifactRef?: string;
  strategy?: 'rolling' | 'blue_green' | 'canary' | 'recreate';
  idempotencyKey: string;
  config?: Record<string, unknown>;
}

export interface DeploymentHandle {
  id: string;
  status: RunStatus;
  environment: string;
  version: string;
  url?: string | null;
  message?: string | null;
}

export interface RollbackRequest {
  project: string;
  environment: string;
  /** Provider deployment id to roll back from. */
  deploymentId: string;
  /** Version or provider deployment id to restore. */
  targetVersion?: string;
  targetRef?: string;
  idempotencyKey: string;
  config?: Record<string, unknown>;
}

export interface CiCdEnvironment {
  name: string;
  type?: string;
  url?: string | null;
  currentVersion?: string | null;
}

export interface CiCdProvider {
  readonly name: string;
  readonly kind: 'CUSTOM_DEVOPS' | 'GITHUB_ACTIONS';
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
  startPipeline(req: PipelineRequest): Promise<PipelineRun>;
  getPipeline(id: string): Promise<PipelineRun>;
  getPipelineLogs(id: string, stage?: string): Promise<string>;
  cancelPipeline(id: string): Promise<void>;
  retryPipeline(id: string): Promise<PipelineRun>;
  deploy(req: DeployRequest): Promise<DeploymentHandle>;
  getDeployment(id: string): Promise<DeploymentHandle>;
  rollback(req: RollbackRequest): Promise<DeploymentHandle>;
  listEnvironments(project: string): Promise<CiCdEnvironment[]>;
}

export function isTerminalRunStatus(s: RunStatus): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled';
}
