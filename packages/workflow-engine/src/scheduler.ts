import type { ExecutionStatus, StepDefinition, StepStatus, WorkflowDefinition } from '@forgeline/shared';
import { evaluateCondition } from './expression';
import { repairStepKeys, stepMap, topologicalOrder } from './graph';
import type { TemplateScope } from './template';

/**
 * Pure scheduling core of the workflow engine.
 *
 * Given a run's definition and the persisted state of its steps, decide what
 * happens next. The runner (in the API) persists these decisions inside a
 * transaction that holds a lock on the run, then dispatches jobs. Keeping this
 * logic pure makes it exhaustively testable and identical across restarts.
 */

export interface StepRuntimeState {
  key: string;
  status: StepStatus;
  attempt: number;
  iteration: number;
  output?: unknown;
  summary?: string | null;
  /** Error kind of the last failure, if any. */
  errorKind?: string | null;
  /** True once a failure is final (repair exhausted / repair failed / not repairable). */
  final?: boolean;
}

export type SchedulerDecision =
  | { type: 'start'; key: string }
  | { type: 'skip'; key: string; reason: string }
  | { type: 'begin_repair'; key: string; repairKey: string; iteration: number }
  | { type: 'rerun_after_repair'; key: string; iteration: number }
  | { type: 'fail_step'; key: string; reason: string };

export type SchedulerOutcome = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'compensate' | 'paused' | 'inactive' | 'stalled';

export interface SchedulerInput {
  definition: WorkflowDefinition;
  executionStatus: ExecutionStatus;
  steps: Record<string, StepRuntimeState>;
  scope: Omit<TemplateScope, 'steps'>;
}

export interface SchedulerResult {
  decisions: SchedulerDecision[];
  outcome: SchedulerOutcome;
  progress: { completed: number; total: number };
  /** Normal steps that failed and block the run. */
  blockingFailures: string[];
}

const ACTIVE: ReadonlySet<StepStatus> = new Set(['QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'REPAIRING']);
const TERMINAL: ReadonlySet<StepStatus> = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'COMPENSATED']);
/** Error kinds a code-repair step cannot fix. */
const NON_REPAIRABLE_KINDS: ReadonlySet<string> = new Set([
  'auth',
  'permission',
  'not_configured',
  'validation',
  'cancelled',
  'rate_limit',
]);

export function isActiveStatus(status: StepStatus): boolean {
  return ACTIVE.has(status);
}
export function isTerminalStatus(status: StepStatus): boolean {
  return TERMINAL.has(status);
}

export function buildScope(scope: Omit<TemplateScope, 'steps'>, steps: Record<string, StepRuntimeState>): TemplateScope {
  const stepScope: TemplateScope['steps'] = {};
  for (const [key, s] of Object.entries(steps)) {
    stepScope[key] = { output: s.output ?? null, status: s.status, summary: s.summary ?? null };
  }
  return { ...scope, steps: stepScope };
}

function isRepairable(def: StepDefinition, s: StepRuntimeState): boolean {
  if (!def.repair || s.final) return false;
  if (s.errorKind && NON_REPAIRABLE_KINDS.has(s.errorKind)) return false;
  return s.iteration < def.repair.maxIterations;
}

export function schedule(input: SchedulerInput): SchedulerResult {
  const { definition } = input;
  const defs = stepMap(definition.steps);
  const repairKeys = repairStepKeys(definition.steps);
  const normalKeys = definition.steps.filter((s) => !repairKeys.has(s.key)).map((s) => s.key);
  const { order } = topologicalOrder(definition.steps);

  // Work on a copy so decisions made in this pass are visible to later checks.
  const state: Record<string, StepRuntimeState> = {};
  for (const s of definition.steps) {
    state[s.key] = input.steps[s.key] ? { ...input.steps[s.key]! } : { key: s.key, status: 'PENDING', attempt: 0, iteration: 0 };
  }

  const decisions: SchedulerDecision[] = [];
  const progress = () => ({
    completed: normalKeys.filter((k) => TERMINAL.has(state[k]!.status)).length,
    total: normalKeys.length,
  });

  const isBlockingFailure = (key: string): boolean => {
    const s = state[key]!;
    const def = defs.get(key)!;
    if (def.continueOnError) return false;
    if (s.status === 'CANCELLED') return true;
    if (s.status !== 'FAILED') return false;
    return !isRepairable(def, s);
  };

  if (input.executionStatus === 'PAUSED') {
    return { decisions, outcome: 'paused', progress: progress(), blockingFailures: [] };
  }
  if (!['RUNNING', 'PENDING', 'WAITING_APPROVAL'].includes(input.executionStatus)) {
    return { decisions, outcome: 'inactive', progress: progress(), blockingFailures: [] };
  }

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;

    // 1) Repair loops.
    for (const key of normalKeys) {
      const def = defs.get(key)!;
      const s = state[key]!;
      if (!def.repair) continue;
      const r = state[def.repair.step]!;

      if (s.status === 'FAILED' && isRepairable(def, s) && !ACTIVE.has(r.status)) {
        decisions.push({ type: 'begin_repair', key, repairKey: def.repair.step, iteration: s.iteration });
        s.status = 'REPAIRING';
        r.status = 'QUEUED';
        r.iteration = s.iteration;
        changed = true;
      } else if (s.status === 'FAILED' && def.repair && !s.final) {
        // Not (or no longer) repairable: finalise so it blocks the run.
        s.final = true;
      } else if (s.status === 'REPAIRING') {
        if (r.status === 'COMPLETED') {
          const next = s.iteration + 1;
          decisions.push({ type: 'rerun_after_repair', key, iteration: next });
          s.status = 'PENDING';
          s.iteration = next;
          s.attempt = 0;
          changed = true;
        } else if (r.status === 'FAILED' || r.status === 'CANCELLED' || r.status === 'SKIPPED') {
          decisions.push({ type: 'fail_step', key, reason: `Repair step '${def.repair.step}' did not succeed` });
          s.status = 'FAILED';
          s.final = true;
          changed = true;
        }
      }
    }

    const blocking = normalKeys.filter(isBlockingFailure);
    let activeCount = definition.steps.filter((s) => ACTIVE.has(state[s.key]!.status)).length;

    // 2) Pending steps in topological order.
    for (const key of order) {
      if (repairKeys.has(key)) continue;
      const s = state[key]!;
      if (s.status !== 'PENDING') continue;
      const def = defs.get(key)!;

      if (blocking.length && def.runIf !== 'always') {
        decisions.push({ type: 'skip', key, reason: `Run failed at '${blocking[0]}'` });
        s.status = 'SKIPPED';
        changed = true;
        continue;
      }

      const deps = def.dependsOn.map((d) => state[d]!);
      if (deps.some((d) => !TERMINAL.has(d.status))) continue;

      const failedDep = def.dependsOn.find((d) => {
        const st = state[d]!.status;
        return (st === 'FAILED' || st === 'CANCELLED') && !defs.get(d)!.continueOnError;
      });
      const skippedDep = def.dependsOn.find((d) => state[d]!.status === 'SKIPPED');

      if (def.runIf === 'all_success' && (failedDep || skippedDep)) {
        decisions.push({
          type: 'skip',
          key,
          reason: failedDep ? `Dependency '${failedDep}' failed` : `Dependency '${skippedDep}' was skipped`,
        });
        s.status = 'SKIPPED';
        changed = true;
        continue;
      }
      if (def.runIf === 'none_failed' && failedDep) {
        decisions.push({ type: 'skip', key, reason: `Dependency '${failedDep}' failed` });
        s.status = 'SKIPPED';
        changed = true;
        continue;
      }

      if (def.when) {
        let ok: boolean;
        try {
          ok = evaluateCondition(def.when, buildScope(input.scope, state));
        } catch (err) {
          decisions.push({ type: 'fail_step', key, reason: `Condition error: ${(err as Error).message}` });
          s.status = 'FAILED';
          s.final = true;
          changed = true;
          continue;
        }
        if (!ok) {
          decisions.push({ type: 'skip', key, reason: 'Condition not met' });
          s.status = 'SKIPPED';
          changed = true;
          continue;
        }
      }

      if (activeCount >= definition.concurrency) continue;
      decisions.push({ type: 'start', key });
      s.status = 'QUEUED';
      activeCount++;
      changed = true;
    }
  }

  const blockingFailures = normalKeys.filter(isBlockingFailure);
  const allNormalTerminal = normalKeys.every((k) => TERMINAL.has(state[k]!.status));
  const anyActive = definition.steps.some((s) => ACTIVE.has(state[s.key]!.status));
  const anyWaiting = definition.steps.some((s) => state[s.key]!.status === 'WAITING_APPROVAL');

  let outcome: SchedulerOutcome;
  if (allNormalTerminal && !anyActive) {
    for (const key of repairKeys) {
      if (state[key]!.status === 'PENDING') {
        decisions.push({ type: 'skip', key, reason: 'Repair not needed' });
        state[key]!.status = 'SKIPPED';
      }
    }
    if (blockingFailures.length) {
      const canCompensate =
        definition.onFailure === 'compensate' && definition.steps.some((s) => s.compensate && state[s.key]!.status === 'COMPLETED');
      outcome = canCompensate ? 'compensate' : 'failed';
    } else {
      outcome = 'completed';
    }
  } else if (anyActive) {
    outcome = 'running';
  } else if (anyWaiting) {
    outcome = 'waiting_approval';
  } else {
    outcome = 'stalled';
  }

  return { decisions, outcome, progress: progress(), blockingFailures };
}

/**
 * Saga compensation: next completed step (reverse topological order) that has
 * a compensation action and has not been compensated yet.
 */
export function nextCompensation(definition: WorkflowDefinition, steps: Record<string, StepRuntimeState>): StepDefinition | null {
  const { order } = topologicalOrder(definition.steps);
  const defs = stepMap(definition.steps);
  for (const key of [...order].reverse()) {
    const def = defs.get(key)!;
    if (def.compensate && steps[key]?.status === 'COMPLETED') return def;
  }
  return null;
}

/**
 * Steps to reset when a user retries a failed step: the step itself plus every
 * normal step that was skipped or cancelled as a consequence of the failure.
 */
export function stepsToResetForRetry(definition: WorkflowDefinition, steps: Record<string, StepRuntimeState>, key: string): string[] {
  const target = steps[key];
  if (!target || !['FAILED', 'CANCELLED'].includes(target.status)) return [];
  const repairKeys = repairStepKeys(definition.steps);
  const reset = [key];
  for (const s of definition.steps) {
    if (s.key === key || repairKeys.has(s.key)) continue;
    const st = steps[s.key]?.status;
    if (st === 'SKIPPED' || st === 'CANCELLED') reset.push(s.key);
  }
  // A failed repair step owned by the retried step is reset as well.
  const owner = definition.steps.find((s) => s.key === key);
  if (owner?.repair && ['FAILED', 'CANCELLED'].includes(steps[owner.repair.step]?.status ?? '')) {
    reset.push(owner.repair.step);
  }
  return reset;
}
