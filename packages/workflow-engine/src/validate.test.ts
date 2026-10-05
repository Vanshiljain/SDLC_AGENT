import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from './validate';

const tool = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: key, type: 'tool', tool: 'demo.echo', ...extra });

describe('validateWorkflowDefinition', () => {
  it('accepts a valid DAG and applies defaults', () => {
    const res = validateWorkflowDefinition({
      steps: [tool('a'), tool('b', { dependsOn: ['a'], input: { v: '{{ steps.a.output.x }}' } })],
    });
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.definition.concurrency).toBe(8);
      expect(res.definition.steps[1]!.runIf).toBe('all_success');
    }
  });

  it('rejects duplicate keys, unknown deps and cycles', () => {
    expect(validateWorkflowDefinition({ steps: [tool('a'), tool('a')] }).issues[0]!.message).toMatch(/Duplicate/);
    expect(validateWorkflowDefinition({ steps: [tool('a', { dependsOn: ['zz'] })] }).issues[0]!.message).toMatch(/Unknown dependency/);
    const cyc = validateWorkflowDefinition({ steps: [tool('a', { dependsOn: ['b'] }), tool('b', { dependsOn: ['a'] })] });
    expect(cyc.valid).toBe(false);
    expect(cyc.issues[0]!.message).toMatch(/cycle/);
  });

  it('rejects templates that reference non-upstream steps', () => {
    const res = validateWorkflowDefinition({
      steps: [tool('a', { input: { x: '{{ steps.b.output.y }}' } }), tool('b')],
    });
    expect(res.valid).toBe(false);
    expect(res.issues[0]!.message).toMatch(/not upstream/);
  });

  it('rejects unknown variables and bad expressions', () => {
    expect(validateWorkflowDefinition({ steps: [tool('a', { when: 'secrets.token == 1' })] }).issues[0]!.message).toMatch(
      /Unknown variable 'secrets'/,
    );
    expect(validateWorkflowDefinition({ steps: [tool('a', { when: 'inputs.x ==' })] }).issues[0]!.message).toMatch(/Invalid expression/);
  });

  it('validates repair wiring', () => {
    const ok = validateWorkflowDefinition({
      steps: [
        tool('code'),
        tool('tests', { dependsOn: ['code'], repair: { step: 'fix', maxIterations: 2 }, successCondition: 'output.failed == 0' }),
        tool('fix', { input: { failures: '{{ steps.tests.output.failures }}', code: '{{ steps.code.output }}' } }),
      ],
    });
    expect(ok.issues).toEqual([]);
    const ownerRef = validateWorkflowDefinition({
      steps: [tool('ci', { input: { ref: '{{ coalesce(steps.fix.output.sha, inputs.ref) }}' }, repair: { step: 'fix' } }), tool('fix')],
    });
    expect(ownerRef.issues).toEqual([]);
    const downstreamRef = validateWorkflowDefinition({
      steps: [
        tool('ci', { repair: { step: 'fix' } }),
        tool('fix'),
        tool('deploy', { dependsOn: ['ci'], input: { sha: '{{ steps.fix.output.sha }}' } }),
      ],
    });
    expect(downstreamRef.issues).toEqual([]);
    const bad = validateWorkflowDefinition({
      steps: [tool('tests', { repair: { step: 'fix' } }), tool('fix', { dependsOn: ['tests'] })],
    });
    expect(bad.valid).toBe(false);
  });

  it('checks tool existence when a registry is supplied', () => {
    const res = validateWorkflowDefinition({ steps: [tool('a')] }, { toolExists: () => false });
    expect(res.issues[0]!.message).toMatch(/Unknown tool/);
  });

  it('requires type-specific config', () => {
    expect(validateWorkflowDefinition({ steps: [{ key: 'gate', name: 'Gate', type: 'approval' }] }).valid).toBe(false);
    expect(
      validateWorkflowDefinition({ steps: [{ key: 'gate', name: 'Gate', type: 'approval', approval: { title: 'Ship?' } }] }).valid,
    ).toBe(true);
  });
});
