import { z } from 'zod';

/**
 * Structured-output schemas for every agent capability. Fields are required
 * (nullable where optional) and free-form maps are avoided so the schemas
 * work with strict JSON-schema structured outputs.
 */

export const ticketDraftSchema = z.object({
  summary: z.string().describe('Concise ticket title, imperative, max 120 chars'),
  issueType: z.enum(['Story', 'Task', 'Bug']),
  priority: z.enum(['Highest', 'High', 'Medium', 'Low']),
  description: z.string().describe('Markdown body: context, scope, technical notes'),
  acceptanceCriteria: z.array(z.string()).describe('Testable acceptance criteria'),
  labels: z.array(z.string()),
});
export type TicketDraft = z.infer<typeof ticketDraftSchema>;

export const technicalSpecSchema = z.object({
  title: z.string(),
  summary: z.string(),
  problem: z.string(),
  goals: z.array(z.string()),
  nonGoals: z.array(z.string()),
  approach: z.string().describe('Markdown description of the technical approach grounded in the existing architecture'),
  components: z.array(z.object({ name: z.string(), responsibility: z.string(), changes: z.string() })),
  apiChanges: z.array(z.object({ method: z.string(), path: z.string(), description: z.string() })),
  dataModelChanges: z.array(z.object({ entity: z.string(), change: z.string() })),
  security: z.array(z.string()),
  testing: z.array(z.string()),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })),
  openQuestions: z.array(z.string()),
  rollout: z.string(),
});
export type TechnicalSpec = z.infer<typeof technicalSpecSchema>;

export const implementationPlanSchema = z.object({
  summary: z.string(),
  branchName: z.string().describe('git branch name, e.g. feature/auth-142-password-reset'),
  complexity: z.enum(['low', 'medium', 'high']),
  affectedFiles: z.array(z.object({ path: z.string(), action: z.enum(['create', 'modify', 'delete']), reason: z.string() })),
  steps: z.array(z.object({ title: z.string(), detail: z.string(), files: z.array(z.string()) })),
  testPlan: z.array(z.string()),
  risks: z.array(z.string()),
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

export const codeChangeSetSchema = z.object({
  summary: z.string(),
  commitMessage: z.string().describe('Conventional commit message'),
  files: z.array(
    z.object({
      path: z.string().describe('Repository-relative path'),
      action: z.enum(['create', 'modify', 'delete']),
      content: z.string().nullable().describe('Complete new file content for create/modify; null for delete'),
      explanation: z.string(),
    }),
  ),
  testsAdded: z.array(z.string()),
  notes: z.array(z.string()),
});
export type CodeChangeSet = z.infer<typeof codeChangeSetSchema>;

export const reviewResultSchema = z.object({
  summary: z.string(),
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  findings: z.array(
    z.object({
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
      category: z.enum([
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
      ]),
      file: z.string().nullable(),
      line: z.number().int().nullable().describe('Line number in the NEW version of the file, if applicable'),
      title: z.string(),
      detail: z.string(),
      suggestion: z.string().nullable(),
    }),
  ),
  dimensions: z.object({
    security: z.enum(['passed', 'warning', 'failed']),
    performance: z.enum(['passed', 'warning', 'failed']),
    architecture: z.enum(['passed', 'warning', 'failed']),
    tests: z.enum(['passed', 'warning', 'failed']),
    maintainability: z.enum(['passed', 'warning', 'failed']),
  }),
  testCoverageGaps: z.array(z.string()),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const qaTestPlanSchema = z.object({
  summary: z.string(),
  testCases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.enum(['UNIT', 'INTEGRATION', 'API', 'E2E', 'REGRESSION', 'SMOKE']),
      priority: z.enum(['P0', 'P1', 'P2']),
      preconditions: z.string().nullable(),
      steps: z.array(z.string()),
      expected: z.string(),
    }),
  ),
  automatedTests: z.array(z.object({ path: z.string(), content: z.string(), description: z.string() })),
});
export type QATestPlan = z.infer<typeof qaTestPlanSchema>;

export const failureAnalysisSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  category: z.enum(['code_bug', 'test_bug', 'environment', 'flaky', 'dependency', 'configuration', 'unknown']),
  confidence: z.number().min(0).max(1),
  affectedFiles: z.array(z.string()),
  suggestedFix: z.string(),
  shouldAttemptFix: z.boolean().describe('True only when an automated code change is likely to fix the failure'),
});
export type FailureAnalysis = z.infer<typeof failureAnalysisSchema>;

export const riskAssessmentSchema = z.object({
  level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  summary: z.string(),
  factors: z.array(z.object({ factor: z.string(), impact: z.enum(['positive', 'negative', 'neutral']) })),
  recommendation: z.enum(['approve', 'approve_with_caution', 'reject']),
  mitigations: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;

export const documentDraftSchema = z.object({
  title: z.string(),
  type: z.enum(['SPECIFICATION', 'ADR', 'RUNBOOK', 'API', 'GUIDE', 'RELEASE_NOTES', 'OTHER']),
  markdown: z.string(),
});
export type DocumentDraft = z.infer<typeof documentDraftSchema>;

export const pullRequestDescriptionSchema = z.object({
  title: z.string(),
  body: z.string().describe('Markdown PR description with Summary, Changes, Testing, and linked ticket'),
});
export type PullRequestDescription = z.infer<typeof pullRequestDescriptionSchema>;

/** Planner output: choose a Flow template, or compose custom steps. */
export const flowPlanSchema = z.object({
  title: z.string().describe('Short run title, e.g. "Password reset for Auth Service"'),
  summary: z.string().describe('One or two sentences on what will happen'),
  template: z.string().nullable().describe('Key of the best matching Flow template, or null for a custom flow'),
  inputs: z.array(z.object({ name: z.string(), value: z.string() })).describe('Template inputs'),
  customSteps: z
    .array(
      z.object({
        key: z.string().describe('snake_case unique key'),
        name: z.string(),
        tool: z.string().describe('Registered tool name'),
        dependsOn: z.array(z.string()),
        inputJson: z.string().describe('JSON object of tool input; may use {{ steps.<key>.output.<field> }} templates'),
        when: z.string().nullable(),
      }),
    )
    .describe('Only when template is null'),
  needsConfirmation: z.boolean().describe('True if the plan has side effects the user should confirm before execution'),
});
export type FlowPlan = z.infer<typeof flowPlanSchema>;

/** Natural-language workflow builder ("Describe Workflow"). */
export const generatedWorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  trigger: z.object({
    type: z.enum(['MANUAL', 'EVENT', 'SCHEDULE']),
    event: z.string().nullable().describe('e.g. jira.issue.transitioned, github.pull_request.opened'),
    filter: z.string().nullable().describe('Expression over { event }, e.g. event.toStatus == "Ready for Development"'),
    cron: z.string().nullable(),
  }),
  steps: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      type: z.enum(['tool', 'approval', 'condition', 'delay']),
      tool: z.string().nullable(),
      dependsOn: z.array(z.string()),
      inputJson: z.string().describe('JSON object; templates allowed: {{ event.issue.key }}, {{ steps.x.output.y }}'),
      when: z.string().nullable(),
      approvalTitle: z.string().nullable(),
    }),
  ),
});
export type GeneratedWorkflow = z.infer<typeof generatedWorkflowSchema>;

/** Command palette natural-language routing. */
export const commandRouteSchema = z.object({
  kind: z.enum(['command', 'navigate', 'search', 'chat']),
  commandId: z.string().nullable(),
  route: z.string().nullable(),
  inputs: z.array(z.object({ name: z.string(), value: z.string() })),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});
export type CommandRoute = z.infer<typeof commandRouteSchema>;

/** Commit-message / summary helper for repaired code. */
export const fixResultSchema = codeChangeSetSchema;
