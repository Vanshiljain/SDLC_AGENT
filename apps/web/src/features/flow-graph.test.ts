import type { WorkflowDefinition } from '@forgeline/shared';
import type { ExecutionStep } from '@/api/types';
import { agentOf, buildFlowGraph, latestSteps } from './flow-graph';

const run = (stepKey: string, iteration: number, status: ExecutionStep['status'], position = 0): ExecutionStep =>
  ({
    id: `${stepKey}-${iteration}`,
    executionId: 'e',
    stepKey,
    name: stepKey,
    type: 'tool',
    tool: 't',
    agent: 'code',
    status,
    attempt: 1,
    maxAttempts: 3,
    iteration,
    position,
    input: null,
    output: null,
    error: null,
    summary: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    nextAttemptAt: null,
    polls: 0,
    createdAt: '',
  }) as ExecutionStep;

const def: WorkflowDefinition = {
  version: 1,
  inputs: {},
  variables: {},
  onFailure: 'fail',
  concurrency: 8,
  steps: [
    {
      key: 'generate',
      name: 'Generate',
      type: 'tool',
      tool: 'code.generate',
      input: {},
      dependsOn: [],
      runIf: 'all_success',
      continueOnError: false,
    },
    {
      key: 'validate',
      name: 'Validate',
      type: 'tool',
      tool: 'code.validate',
      input: {},
      dependsOn: ['generate'],
      runIf: 'all_success',
      continueOnError: false,
      repair: { step: 'fix', maxIterations: 2 },
    },
    { key: 'fix', name: 'Fix', type: 'tool', tool: 'code.fix', input: {}, dependsOn: [], runIf: 'all_success', continueOnError: false },
  ],
};

describe('run graph', () => {
  it('keeps the latest iteration of each step and counts self-heals', () => {
    const latest = latestSteps([run('validate', 0, 'FAILED'), run('validate', 1, 'COMPLETED', 5)]);
    expect(latest.get('validate')?.run.status).toBe('COMPLETED');
    expect(latest.get('validate')?.iterations).toBe(1);
  });

  it('builds nodes, dependency edges and a dashed repair edge', () => {
    const { nodes, edges } = buildFlowGraph(def, [run('generate', 0, 'COMPLETED'), run('validate', 0, 'RUNNING')]);
    expect(nodes.map((n) => n.id)).toEqual(['generate', 'validate', 'fix']);
    expect(edges.find((e) => e.id === 'generate->validate')?.animated).toBe(true);
    const repair = edges.find((e) => e.id === 'validate~>fix');
    expect(repair?.label).toBe('repair');
    expect(nodes.find((n) => n.id === 'fix')?.data.repairOf).toBe('validate');
    // Layout assigns distinct positions.
    expect(new Set(nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(3);
  });

  it('gives approval steps the approval persona', () => {
    expect(agentOf({ type: 'approval' }).label).toBe('Approval');
    expect(agentOf({ agent: 'qa' }).label).toBe('QA');
  });
});
