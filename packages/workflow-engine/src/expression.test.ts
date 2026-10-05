import { describe, expect, it } from 'vitest';
import { collectPaths, evaluateCondition, evaluateExpression, ExpressionError } from './expression';
import { resolveTemplates } from './template';

const scope = {
  inputs: { env: 'staging', count: 3, tags: ['auth', 'api'] },
  variables: {},
  steps: {
    tests: { output: { passed: 10, failed: 0, suites: [{ name: 'a' }] }, status: 'COMPLETED' },
    ticket: { output: { key: 'AUTH-142', url: 'https://jira/AUTH-142' }, status: 'COMPLETED' },
  },
};

describe('expression evaluator', () => {
  it.each([
    ["inputs.env == 'staging'", true],
    ["inputs.env != 'production'", true],
    ['steps.tests.output.failed == 0 && steps.tests.output.passed > 5', true],
    ['steps.tests.output.failed > 0 || inputs.count >= 3', true],
    ['!(inputs.count < 2)', true],
    ["'auth' in inputs.tags", true],
    ["'web' in inputs.tags", false],
    ['len(inputs.tags) == 2', true],
    ["contains(inputs.tags, 'api')", true],
    ['steps.missing.output.value == null', true],
    ['inputs.count * 2 + 1 == 7', true],
    ["inputs.env == 'staging' ? true : false", true],
    ['steps.tests.output.suites[0].name == "a"', true],
    ["startsWith(steps.ticket.output.key, 'AUTH-')", true],
    ['empty(inputs.nothing)', true],
  ])('%s → %s', (expr, expected) => {
    expect(evaluateCondition(expr, scope)).toBe(expected);
  });

  it('returns raw values and handles strings', () => {
    expect(evaluateExpression('steps.ticket.output.key', scope)).toBe('AUTH-142');
    expect(evaluateExpression("'PR for ' + steps.ticket.output.key", scope)).toBe('PR for AUTH-142');
    expect(evaluateExpression("slugify('Add Password Reset!')", scope)).toBe('add-password-reset');
    expect(evaluateExpression('1 / 0', scope)).toBeNull();
  });

  it('blocks prototype access and unknown functions', () => {
    expect(() => evaluateExpression('inputs.__proto__', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('inputs["constructor"]', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('constructor', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('process.exit(1)', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('eval("1")', scope)).toThrow(/Unknown function/);
  });

  it('rejects malformed input', () => {
    expect(() => evaluateExpression("inputs.env == 'x", scope)).toThrow(/Unterminated/);
    expect(() => evaluateExpression('inputs.env ==', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('a ; b', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('x'.repeat(3000), scope)).toThrow(/exceeds/);
  });

  it('collects referenced paths', () => {
    expect(collectPaths("steps.tests.output.failed == 0 && inputs.env == 'x'")).toEqual([
      'steps.tests.output.failed',
      'inputs.env',
    ]);
  });
});

describe('templates', () => {
  it('returns raw values for whole templates and interpolates mixed strings', () => {
    const out = resolveTemplates(
      {
        key: '{{ steps.ticket.output.key }}',
        count: '{{ inputs.count }}',
        title: 'Fix {{ steps.ticket.output.key }} in {{ inputs.env }}',
        nested: [{ suites: '{{ steps.tests.output.suites }}' }],
        plain: 'no templates',
        num: 5,
      },
      scope,
    );
    expect(out).toEqual({
      key: 'AUTH-142',
      count: 3,
      title: 'Fix AUTH-142 in staging',
      nested: [{ suites: [{ name: 'a' }] }],
      plain: 'no templates',
      num: 5,
    });
  });

  it('renders missing values as empty strings in interpolation', () => {
    expect(resolveTemplates('x{{ steps.nope.output.y }}x', scope)).toBe('xx');
  });
});
