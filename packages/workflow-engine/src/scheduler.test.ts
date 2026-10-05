import { describe, expect, it } from 'vitest';
import type { ExecutionStatus, WorkflowDefinitionInput } from '@forgeline/shared';
import { schedule, nextCompensation, stepsToResetForRetry, type StepRuntimeState, type SchedulerOutcome } from './scheduler';
import { assertValidWorkflowDefinition } from './validate';
import { evaluateCondition } from './expression';
import { buildScope } from './scheduler';
import { computeBackoffDelay } from './backoff';

type Behaviour = (ctx: { iteration: number; attempt: number }) => { ok: true; output?: unknown } | { ok: false; kind?: string };

/**
 * In-memory simulator: applies scheduler decisions exactly as the API runner
 * does, executing steps synchronously with scripted behaviours.
 */
function simulate(raw: WorkflowDefinitionInput, behaviours: Record<string, Behaviour> = {}, opts: { approvals?: Record<string, boolean> } = {}) {
  const definition = assertValidWorkflowDefinition(raw);
  const steps: Record<string, StepRuntimeState> = {};
  const order: string[] = [];
  let status: ExecutionStatus = 'RUNNING';
  let outcome: SchedulerOutcome = 'running';
  const scopeBase = { inputs: {}, variables: {} };

  for (let tick = 0; tick < 200; tick++) {
    const result = schedule({ definition, executionStatus: status, steps, scope: scopeBase });
    for (const d of result.decisions) {
      const s = (steps[d.type === 'begin_repair' ? d.key : d.key] ??= { key: d.key, status: 'PENDING', attempt: 0, iteration: 0 });
      switch (d.type) {
        case 'start':
          s.status = 'QUEUED';
          break;
        case 'skip':
          s.status = 'SKIPPED';
          break;
        case 'begin_repair': {
          s.status = 'REPAIRING';
          const r = (steps[d.repairKey] ??= { key: d.repairKey, status: 'PENDING', attempt: 0, iteration: 0 });
          r.status = 'QUEUED';
          r.iteration = d.iteration;
          break;
        }
        case 'rerun_after_repair':
          s.status = 'PENDING';
          s.iteration = d.iteration;
          s.attempt = 0;
          break;
        case 'fail_step':
          s.status = 'FAILED';
          s.final = true;
          break;
      }
    }
    outcome = result.outcome;
    if (outcome !== 'running') break;

    // Execute every queued step (as workers would).
    for (const s of Object.values(steps).filter((x) => x.status === 'QUEUED')) {
      const def = definition.steps.find((x) => x.key === s.key)!;
      order.push(s.iteration ? `${s.key}#${s.iteration}` : s.key);
      if (def.type === 'approval') {
        const approved = opts.approvals?.[s.key];
        s.status = approved === undefined ? 'WAITING_APPROVAL' : approved ? 'COMPLETED' : 'FAILED';
        continue;
      }
      const res = (behaviours[s.key] ?? (() => ({ ok: true })))({ iteration: s.iteration, attempt: s.attempt });
      if (res.ok) {
        s.output = res.output ?? {};
        const passed = def.successCondition
          ? evaluateCondition(def.successCondition, { ...buildScope(scopeBase, steps), output: s.output })
          : true;
        s.status = passed ? 'COMPLETED' : 'FAILED';
        s.errorKind = passed ? null : 'assertion';
      } else {
        s.status = 'FAILED';
        s.errorKind = res.kind ?? 'external';
      }
    }
    if (Object.values(steps).every((s) => s.status !== 'QUEUED')) {
      // continue loop; scheduler will react to new state
    }
    if (status === 'RUNNING' && outcome === 'running') continue;
  }
  return { steps, order, outcome, definition };
}

const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: key, type: 'tool' as const, tool: 'demo.echo', ...extra });

describe('scheduler', () => {
  it('runs sequential steps in order and completes', () => {
    const r = simulate({ steps: [t('a'), t('b', { dependsOn: ['a'] }), t('c', { dependsOn: ['b'] })] });
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.outcome).toBe('completed');
  });

  it('starts independent steps in parallel', () => {
    const def = assertValidWorkflowDefinition({ steps: [t('a'), t('b'), t('c', { dependsOn: ['a', 'b'] })] });
    const res = schedule({ definition: def, executionStatus: 'RUNNING', steps: {}, scope: { inputs: {}, variables: {} } });
    expect(res.decisions.filter((d) => d.type === 'start').map((d) => d.key)).toEqual(['a', 'b']);
  });

  it('respects the concurrency limit', () => {
    const def = assertValidWorkflowDefinition({ concurrency: 2, steps: [t('a'), t('b'), t('c')] });
    const res = schedule({ definition: def, executionStatus: 'RUNNING', steps: {}, scope: { inputs: {}, variables: {} } });
    expect(res.decisions.filter((d) => d.type === 'start')).toHaveLength(2);
  });

  it('skips a conditional branch and joins with none_failed', () => {
    const r = simulate({
      inputs: {},
      steps: [
        t('check', { tool: 'demo.echo' }),
        t('big', { dependsOn: ['check'], when: 'steps.check.output.size > 10' }),
        t('small', { dependsOn: ['check'], when: 'steps.check.output.size <= 10' }),
        t('join', { dependsOn: ['big', 'small'], runIf: 'none_failed' }),
        t('after_big', { dependsOn: ['big'] }),
      ],
    }, { check: () => ({ ok: true, output: { size: 3 } }) });
    expect(r.steps.big!.status).toBe('SKIPPED');
    expect(r.steps.small!.status).toBe('COMPLETED');
    expect(r.steps.join!.status).toBe('COMPLETED');
    expect(r.steps.after_big!.status).toBe('SKIPPED');
    expect(r.outcome).toBe('completed');
  });

  it('fails fast but still runs always-steps', () => {
    const r = simulate(
      {
        steps: [t('a'), t('b', { dependsOn: ['a'] }), t('notify', { dependsOn: ['b'], runIf: 'always' }), t('c')],
      },
      { a: () => ({ ok: false, kind: 'auth' }) },
    );
    expect(r.steps.a!.status).toBe('FAILED');
    expect(r.steps.b!.status).toBe('SKIPPED');
    expect(r.steps.notify!.status).toBe('COMPLETED');
    expect(r.outcome).toBe('failed');
  });

  it('continueOnError does not fail the run', () => {
    const r = simulate({ steps: [t('lint', { continueOnError: true }), t('b', { dependsOn: ['lint'] })] }, { lint: () => ({ ok: false }) });
    expect(r.steps.b!.status).toBe('COMPLETED');
    expect(r.outcome).toBe('completed');
  });

  it('repairs failing tests and re-runs them (tests → fix → tests)', () => {
    const r = simulate(
      {
        steps: [
          t('code'),
          t('tests', { dependsOn: ['code'], successCondition: 'output.failed == 0', repair: { step: 'fix', maxIterations: 3 } }),
          t('fix'),
          t('review', { dependsOn: ['tests'] }),
        ],
      },
      { tests: ({ iteration }) => ({ ok: true, output: { failed: iteration < 2 ? 2 : 0 } }) },
    );
    expect(r.order).toEqual(['code', 'tests', 'fix#0'.replace('#0', ''), 'tests#1', 'fix#1', 'tests#2', 'review']);
    expect(r.steps.tests!.status).toBe('COMPLETED');
    expect(r.steps.tests!.iteration).toBe(2);
    expect(r.outcome).toBe('completed');
  });

  it('fails when repair iterations are exhausted', () => {
    const r = simulate(
      {
        steps: [
          t('tests', { successCondition: 'output.failed == 0', repair: { step: 'fix', maxIterations: 2 } }),
          t('fix'),
          t('deploy', { dependsOn: ['tests'] }),
        ],
      },
      { tests: () => ({ ok: true, output: { failed: 1 } }) },
    );
    expect(r.steps.tests!.status).toBe('FAILED');
    expect(r.steps.deploy!.status).toBe('SKIPPED');
    expect(r.order.filter((x) => x.startsWith('fix'))).toHaveLength(2);
    expect(r.outcome).toBe('failed');
  });

  it('does not attempt repair for non-repairable errors', () => {
    const r = simulate(
      { steps: [t('tests', { repair: { step: 'fix', maxIterations: 2 } }), t('fix')] },
      { tests: () => ({ ok: false, kind: 'auth' }) },
    );
    expect(r.order).toEqual(['tests']);
    expect(r.steps.fix!.status).toBe('SKIPPED');
    expect(r.outcome).toBe('failed');
  });

  it('fails the owner when the repair step fails', () => {
    const r = simulate(
      { steps: [t('tests', { successCondition: 'output.ok', repair: { step: 'fix', maxIterations: 2 } }), t('fix')] },
      { tests: () => ({ ok: true, output: { ok: false } }), fix: () => ({ ok: false }) },
    );
    expect(r.steps.tests!.status).toBe('FAILED');
    expect(r.outcome).toBe('failed');
  });

  it('waits on approvals and continues once approved', () => {
    const pending = simulate({ steps: [t('plan'), { key: 'gate', name: 'Gate', type: 'approval', approval: { title: 'Ok?' }, dependsOn: ['plan'] }, t('code', { dependsOn: ['gate'] })] });
    expect(pending.outcome).toBe('waiting_approval');
    expect(pending.steps.code).toBeUndefined();

    const approved = simulate(
      { steps: [t('plan'), { key: 'gate', name: 'Gate', type: 'approval', approval: { title: 'Ok?' }, dependsOn: ['plan'] }, t('code', { dependsOn: ['gate'] })] },
      {},
      { approvals: { gate: true } },
    );
    expect(approved.outcome).toBe('completed');

    const rejected = simulate(
      { steps: [{ key: 'gate', name: 'Gate', type: 'approval', approval: { title: 'Ok?' } }, t('code', { dependsOn: ['gate'] })] },
      {},
      { approvals: { gate: false } },
    );
    expect(rejected.outcome).toBe('failed');
    expect(rejected.steps.code!.status).toBe('SKIPPED');
  });

  it('optional gate skipped by condition lets the flow continue with none_failed', () => {
    const r = simulate({
      inputs: { requireApproval: { type: 'boolean', default: false } },
      steps: [
        { key: 'gate', name: 'Gate', type: 'approval', approval: { title: 'Ok?' }, when: 'inputs.requireApproval == true' },
        t('code', { dependsOn: ['gate'], runIf: 'none_failed' }),
      ],
    });
    expect(r.steps.gate!.status).toBe('SKIPPED');
    expect(r.steps.code!.status).toBe('COMPLETED');
  });

  it('requests compensation when onFailure=compensate', () => {
    const r = simulate(
      {
        onFailure: 'compensate',
        steps: [t('branch', { compensate: { tool: 'demo.echo', input: {} } }), t('deploy', { dependsOn: ['branch'] })],
      },
      { deploy: () => ({ ok: false, kind: 'external' }) },
    );
    expect(r.outcome).toBe('compensate');
    expect(nextCompensation(r.definition, r.steps)?.key).toBe('branch');
    r.steps.branch!.status = 'COMPENSATED';
    expect(nextCompensation(r.definition, r.steps)).toBeNull();
  });

  it('is inert while paused and inactive when terminal', () => {
    const def = assertValidWorkflowDefinition({ steps: [t('a')] });
    expect(schedule({ definition: def, executionStatus: 'PAUSED', steps: {}, scope: { inputs: {}, variables: {} } }).outcome).toBe('paused');
    expect(schedule({ definition: def, executionStatus: 'CANCELLED', steps: {}, scope: { inputs: {}, variables: {} } }).decisions).toEqual([]);
  });

  it('computes steps to reset for a manual retry', () => {
    const r = simulate({ steps: [t('a'), t('b', { dependsOn: ['a'] }), t('c')] }, { a: () => ({ ok: false, kind: 'auth' }) });
    const reset = stepsToResetForRetry(r.definition, r.steps, 'a');
    expect(reset.sort()).toEqual(['a', 'b']);
  });
});

describe('backoff', () => {
  it('grows exponentially within bounds and honours Retry-After', () => {
    const fixedRandom = () => 1;
    expect(computeBackoffDelay({ initialDelayMs: 1000, maxDelayMs: 60000 }, 1, undefined, fixedRandom)).toBe(1000);
    expect(computeBackoffDelay({ initialDelayMs: 1000, maxDelayMs: 60000 }, 3, undefined, fixedRandom)).toBe(4000);
    expect(computeBackoffDelay({ initialDelayMs: 1000, maxDelayMs: 5000 }, 10, undefined, fixedRandom)).toBe(5000);
    expect(computeBackoffDelay({ initialDelayMs: 1000, maxDelayMs: 5000 }, 1, 30000, fixedRandom)).toBe(30000);
    expect(computeBackoffDelay({ backoff: 'fixed', initialDelayMs: 750 }, 4)).toBe(750);
    const zeroRandom = () => 0;
    expect(computeBackoffDelay({ initialDelayMs: 1000 }, 2, undefined, zeroRandom)).toBe(1000);
  });
});
