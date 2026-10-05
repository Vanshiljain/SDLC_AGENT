import type { StepDefinition } from '@forgeline/shared';
import { ancestors, uniqueKey, wouldCycle } from './flow-utils';

const s = (key: string, dependsOn: string[] = []): StepDefinition => ({
  key,
  name: key,
  type: 'tool',
  input: {},
  dependsOn,
  runIf: 'all_success',
  continueOnError: false,
});

describe('flow builder helpers', () => {
  const steps = [s('a'), s('b', ['a']), s('c', ['b'])];

  it('detects cycles before an edge is added', () => {
    expect(wouldCycle(steps, 'c', 'a')).toBe(true);
    expect(wouldCycle(steps, 'a', 'c')).toBe(false);
    expect(wouldCycle(steps, 'b', 'b')).toBe(true);
  });

  it('lists all ancestors for template references', () => {
    expect(ancestors(steps, 'c').sort()).toEqual(['a', 'b']);
    expect(ancestors(steps, 'a')).toEqual([]);
  });

  it('creates unique snake_case keys', () => {
    expect(uniqueKey('Create Issue', steps)).toBe('create_issue');
    expect(uniqueKey('a', steps)).toBe('a_2');
    expect(uniqueKey('9 lives', [])).toBe('s_9_lives');
    expect(uniqueKey('!!!', [])).toBe('step');
  });
});
