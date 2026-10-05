import { z } from 'zod';

/**
 * Flow (workflow) definition language.
 *
 * A Flow is a DAG of steps connected by `dependsOn`. Branching is expressed
 * with `when` conditions, self-healing loops with `repair`, and sagas with
 * `compensate`. Inputs of a step may reference earlier outputs using
 * `{{ steps.<key>.output.<path> }}` templates.
 */

export const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const stepKeySchema = z.string().regex(STEP_KEY_PATTERN, 'Step keys must be snake_case, start with a letter, max 64 chars');

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  initialDelayMs: z.number().int().min(0).max(3_600_000).default(2_000),
  maxDelayMs: z.number().int().min(0).max(3_600_000).default(60_000),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: 'exponential',
  initialDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export const approvalConfigSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  /** Policy action key, e.g. "deploy.production" — used by the policy engine. */
  action: z.string().max(100).optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  /** Permission the approver must hold. Defaults to approval:decide. */
  requiredPermission: z.string().max(64).optional(),
  expiresInMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .optional(),
  allowSelfApproval: z.boolean().optional(),
  /** Templated context shown to the approver (changes, QA, CI…). */
  context: z.record(z.string(), z.unknown()).optional(),
});
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

export const STEP_TYPES = ['tool', 'approval', 'condition', 'delay'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const stepDefinitionSchema = z.object({
  key: stepKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  type: z.enum(STEP_TYPES).default('tool'),
  /** Registered tool name (required for type=tool), e.g. "jira.createIssue". */
  tool: z.string().max(100).optional(),
  /** Tool input; string values may contain {{ templates }}. */
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(stepKeySchema).default([]),
  /** Run only when this expression is truthy; otherwise the step is SKIPPED. */
  when: z.string().max(1000).optional(),
  /**
   * all_success: run only when every dependency completed (a skipped dependency skips this step).
   * none_failed: run when no dependency failed (skipped dependencies are fine) — use after optional gates/branches.
   * always: run once every dependency is terminal, regardless of outcome (cleanup/notify).
   */
  runIf: z.enum(['all_success', 'none_failed', 'always']).default('all_success'),
  retry: retryPolicySchema.partial().optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(6 * 3_600_000)
    .optional(),
  /** If true a failure does not fail the run; dependents still run. */
  continueOnError: z.boolean().default(false),
  /** Evaluated against the step output; false turns success into a failure. */
  successCondition: z.string().max(1000).optional(),
  /** Self-healing: on failure run `step` then re-run this step, up to maxIterations. */
  repair: z
    .object({
      step: stepKeySchema,
      maxIterations: z.number().int().min(1).max(5).default(2),
    })
    .optional(),
  /** Compensation action executed in reverse order when the run is rolled back. */
  compensate: z
    .object({
      tool: z.string().max(100),
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  approval: approvalConfigSchema.optional(),
  /** type=condition: expression whose boolean result becomes output.result. */
  expression: z.string().max(1000).optional(),
  /** type=delay */
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3_600_000)
    .optional(),
  /** Visual-builder metadata only. */
  ui: z
    .object({
      x: z.number(),
      y: z.number(),
      color: z.string().max(32).optional(),
      icon: z.string().max(32).optional(),
    })
    .optional(),
  /** Agent persona shown in visualizations (planning, code, qa…). */
  agent: z.string().max(40).optional(),
});
export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export type StepDefinitionInput = z.input<typeof stepDefinitionSchema>;

export const workflowInputSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
});
export type WorkflowInputSpec = z.infer<typeof workflowInputSchema>;

export const workflowDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  inputs: z.record(z.string(), workflowInputSchema).default({}),
  variables: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(stepDefinitionSchema).min(1).max(100),
  /** fail: stop the run. compensate: run compensations of completed steps. */
  onFailure: z.enum(['fail', 'compensate']).default('fail'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(14 * 24 * 3_600_000)
    .optional(),
  /** Max steps executing at once within one run. */
  concurrency: z.number().int().min(1).max(32).default(8),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;

export const triggerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MANUAL') }),
  z.object({
    type: z.literal('SCHEDULE'),
    cron: z.string().min(9).max(120),
    timezone: z.string().max(64).default('UTC'),
  }),
  z.object({
    type: z.literal('EVENT'),
    /** e.g. "jira.issue.transitioned", "github.pull_request.opened" */
    event: z.string().min(3).max(120),
    /** Expression evaluated against { event } to filter deliveries. */
    filter: z.string().max(1000).optional(),
    /** Map event payload into workflow inputs using templates. */
    inputs: z.record(z.string(), z.unknown()).default({}),
  }),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

/** Builder node palette categories. */
export const NODE_CATEGORIES = [
  'trigger',
  'ai',
  'jira',
  'trello',
  'github',
  'github_actions',
  'notion',
  'devops',
  'quality',
  'control',
  'notification',
  'http',
] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];
