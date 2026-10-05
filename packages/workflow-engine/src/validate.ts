import {
  workflowDefinitionSchema,
  type StepDefinition,
  type WorkflowDefinition,
} from '@forgeline/shared';
import { collectPaths, parseExpression } from './expression';
import { ancestors, repairStepKeys, topologicalOrder } from './graph';
import { extractTemplateExpressions, referencedStepKeys } from './template';

export interface ValidationIssue {
  path: string;
  message: string;
  stepKey?: string;
}

export type ValidationResult =
  | { valid: true; definition: WorkflowDefinition; issues: [] }
  | { valid: false; definition?: WorkflowDefinition; issues: ValidationIssue[] };

export interface ValidateOptions {
  /** Return true if a tool name is registered. When omitted, tool names are not checked. */
  toolExists?: (tool: string) => boolean;
}

const KNOWN_SCOPE_ROOTS = new Set(['inputs', 'variables', 'steps', 'project', 'execution', 'repair', 'env', 'event', 'output', 'error']);

function checkExpression(
  expr: string,
  path: string,
  stepKey: string | undefined,
  issues: ValidationIssue[],
): void {
  try {
    parseExpression(expr);
  } catch (err) {
    issues.push({ path, stepKey, message: `Invalid expression "${expr}": ${(err as Error).message}` });
  }
}

/**
 * Structural + semantic validation of a Flow definition. Validates the schema,
 * unique keys, dependency references, acyclicity, repair/compensation wiring,
 * expressions, and that templates only reference upstream steps.
 */
export function validateWorkflowDefinition(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const def = parsed.data;
  const issues: ValidationIssue[] = [];
  const keys = new Set<string>();

  def.steps.forEach((s, idx) => {
    if (keys.has(s.key)) issues.push({ path: `steps.${idx}.key`, stepKey: s.key, message: `Duplicate step key '${s.key}'` });
    keys.add(s.key);
  });

  const repairKeys = repairStepKeys(def.steps);
  const repairOwners = new Map<string, string>();

  def.steps.forEach((s, idx) => {
    const base = `steps.${idx}`;
    for (const d of s.dependsOn) {
      if (!keys.has(d)) issues.push({ path: `${base}.dependsOn`, stepKey: s.key, message: `Unknown dependency '${d}'` });
      if (d === s.key) issues.push({ path: `${base}.dependsOn`, stepKey: s.key, message: 'A step cannot depend on itself' });
      if (repairKeys.has(d)) issues.push({ path: `${base}.dependsOn`, stepKey: s.key, message: `'${d}' is a repair step and cannot be a dependency` });
    }

    switch (s.type) {
      case 'tool':
        if (!s.tool) issues.push({ path: `${base}.tool`, stepKey: s.key, message: 'Tool steps require a tool' });
        else if (options.toolExists && !options.toolExists(s.tool)) {
          issues.push({ path: `${base}.tool`, stepKey: s.key, message: `Unknown tool '${s.tool}'` });
        }
        break;
      case 'approval':
        if (!s.approval) issues.push({ path: `${base}.approval`, stepKey: s.key, message: 'Approval steps require approval settings' });
        break;
      case 'condition':
        if (!s.expression) issues.push({ path: `${base}.expression`, stepKey: s.key, message: 'Condition steps require an expression' });
        break;
      case 'delay':
        if (s.delayMs === undefined) issues.push({ path: `${base}.delayMs`, stepKey: s.key, message: 'Delay steps require delayMs' });
        break;
    }

    if (s.repair) {
      const target = s.repair.step;
      if (!keys.has(target)) {
        issues.push({ path: `${base}.repair.step`, stepKey: s.key, message: `Unknown repair step '${target}'` });
      } else if (target === s.key) {
        issues.push({ path: `${base}.repair.step`, stepKey: s.key, message: 'A step cannot repair itself' });
      }
      if (repairOwners.has(target)) {
        issues.push({ path: `${base}.repair.step`, stepKey: s.key, message: `Repair step '${target}' is already used by '${repairOwners.get(target)}'` });
      }
      repairOwners.set(target, s.key);
    }
    if (repairKeys.has(s.key)) {
      if (s.dependsOn.length) issues.push({ path: `${base}.dependsOn`, stepKey: s.key, message: 'Repair steps must not declare dependencies' });
      if (s.repair) issues.push({ path: `${base}.repair`, stepKey: s.key, message: 'Repair steps cannot have their own repair step' });
      if (s.type !== 'tool') issues.push({ path: `${base}.type`, stepKey: s.key, message: 'Repair steps must be tool steps' });
    }

    if (s.compensate && options.toolExists && !options.toolExists(s.compensate.tool)) {
      issues.push({ path: `${base}.compensate.tool`, stepKey: s.key, message: `Unknown compensation tool '${s.compensate.tool}'` });
    }

    if (s.when) checkExpression(s.when, `${base}.when`, s.key, issues);
    if (s.successCondition) checkExpression(s.successCondition, `${base}.successCondition`, s.key, issues);
    if (s.expression) checkExpression(s.expression, `${base}.expression`, s.key, issues);
    for (const expr of extractTemplateExpressions([s.input, s.approval?.context, s.approval?.title, s.approval?.description, s.compensate?.input])) {
      checkExpression(expr, `${base}.input`, s.key, issues);
    }
  });

  if (issues.length) return { valid: false, definition: def, issues };

  const { cycle } = topologicalOrder(def.steps);
  if (cycle) {
    return { valid: false, definition: def, issues: [{ path: 'steps', message: `Dependency cycle detected between: ${cycle.join(', ')}` }] };
  }

  // Templates/conditions may only reference upstream steps (or, for repair steps, their owner's upstream + the owner).
  for (const [idx, s] of def.steps.entries()) {
    const exprs = [
      ...extractTemplateExpressions([s.input, s.approval, s.compensate?.input]),
      ...(s.when ? [s.when] : []),
      ...(s.expression ? [s.expression] : []),
    ];
    const allowed = allowedReferences(def.steps, s, repairOwners);
    for (const ref of referencedStepKeys(exprs)) {
      if (!keys.has(ref)) {
        issues.push({ path: `steps.${idx}`, stepKey: s.key, message: `References unknown step '${ref}'` });
      } else if (!allowed.has(ref)) {
        issues.push({ path: `steps.${idx}`, stepKey: s.key, message: `References step '${ref}' which is not upstream; add it to dependsOn` });
      }
    }
    for (const expr of exprs) {
      for (const path of collectPaths(expr)) {
        const root = path.split('.')[0]!;
        if (!KNOWN_SCOPE_ROOTS.has(root)) {
          issues.push({ path: `steps.${idx}`, stepKey: s.key, message: `Unknown variable '${root}' in "${expr}"` });
        }
      }
    }
  }

  return issues.length ? { valid: false, definition: def, issues } : { valid: true, definition: def, issues: [] };
}

function allowedReferences(
  steps: StepDefinition[],
  step: StepDefinition,
  repairOwners: Map<string, string>,
): Set<string> {
  const owner = repairOwners.get(step.key);
  if (owner) {
    const set = ancestors(steps, owner);
    set.add(owner);
    return set;
  }
  const set = ancestors(steps, step.key);
  // A step may read the output of its own repair step (e.g. the commit SHA produced by a fix).
  if (step.repair) set.add(step.repair.step);
  return set;
}

/** Throwing variant for internal use. */
export function assertValidWorkflowDefinition(raw: unknown, options?: ValidateOptions): WorkflowDefinition {
  const result = validateWorkflowDefinition(raw, options);
  if (!result.valid) {
    const msg = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new WorkflowValidationError(msg, result.issues);
  }
  return result.definition;
}

export class WorkflowValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(`Invalid workflow definition: ${message}`);
    this.name = 'WorkflowValidationError';
  }
}
