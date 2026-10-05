import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as shared from '@forgeline/shared';

/**
 * The shared package mirrors Prisma enums for the browser and tools. This test
 * fails the build if they drift.
 */
const schema = readFileSync(join(__dirname, '../../../../packages/database/prisma/schema.prisma'), 'utf8');
const prismaEnums = new Map<string, string[]>();
for (const m of schema.matchAll(/^enum (\w+) \{([^}]*)\}/gm)) {
  prismaEnums.set(
    m[1]!,
    m[2]!
      .split('\n')
      .map((l) => l.trim().split(/\s/)[0]!)
      .filter((v) => v && !v.startsWith('//') && !v.startsWith('@@')),
  );
}

const PAIRS: [string, readonly string[]][] = [
  ['OrgRole', shared.ORG_ROLES],
  ['ProjectRole', shared.PROJECT_ROLES],
  ['IntegrationProvider', shared.INTEGRATION_PROVIDERS],
  ['IntegrationStatus', shared.INTEGRATION_STATUSES],
  ['IntegrationAuthType', shared.INTEGRATION_AUTH_TYPES],
  ['HealthStatus', shared.HEALTH_STATUSES],
  ['ExecutionStatus', shared.EXECUTION_STATUSES],
  ['StepStatus', shared.STEP_STATUSES],
  ['ExecutionMode', shared.EXECUTION_MODES],
  ['TriggerSource', shared.TRIGGER_SOURCES],
  ['TriggerType', shared.TRIGGER_TYPES],
  ['WorkflowStatus', shared.WORKFLOW_STATUSES],
  ['ApprovalStatus', shared.APPROVAL_STATUSES],
  ['RiskLevel', shared.RISK_LEVELS],
  ['EnvironmentType', shared.ENVIRONMENT_TYPES],
  ['DeploymentStatus', shared.DEPLOYMENT_STATUSES],
  ['QATestType', shared.QA_TEST_TYPES],
  ['QARunStatus', shared.QA_RUN_STATUSES],
  ['CodeGenerationStatus', shared.CODE_GENERATION_STATUSES],
  ['ReviewVerdict', shared.REVIEW_VERDICTS],
  ['ReviewStatus', shared.REVIEW_STATUSES],
  ['ArtifactType', shared.ARTIFACT_TYPES],
  ['DocumentType', shared.DOCUMENT_TYPES],
  ['TaskStatus', shared.TASK_STATUSES],
  ['TaskPriority', shared.TASK_PRIORITIES],
  ['KnowledgeSourceType', shared.KNOWLEDGE_SOURCE_TYPES],
  ['ToolExecutionStatus', shared.TOOL_EXECUTION_STATUSES],
  ['AuditActorType', shared.AUDIT_ACTOR_TYPES],
  ['AuditStatus', shared.AUDIT_STATUSES],
  ['LogLevel', shared.LOG_LEVELS],
];

describe('Prisma ↔ shared enum parity', () => {
  it.each(PAIRS)('%s matches', (name, values) => {
    expect(prismaEnums.get(name)).toBeDefined();
    expect([...values].sort()).toEqual([...prismaEnums.get(name)!].sort());
  });
});
