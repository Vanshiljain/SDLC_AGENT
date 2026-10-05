import { collectPaths, evaluateExpression, ExpressionError } from './expression';

/**
 * Template resolution for step inputs.
 *
 *   "{{ steps.ticket.output.key }}"          → raw value (any type)
 *   "Fixes {{ steps.ticket.output.key }}"    → string interpolation
 *
 * Templates use the same safe expression language as conditions.
 */
const TEMPLATE_RE = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{\s*([\s\S]+?)\s*\}\}$/;
const MAX_DEPTH = 20;

export type TemplateScope = {
  inputs: Record<string, unknown>;
  variables: Record<string, unknown>;
  steps: Record<string, { output: unknown; status: string; summary?: string | null }>;
  project?: Record<string, unknown> | null;
  execution?: Record<string, unknown>;
  repair?: Record<string, unknown> | null;
  env?: Record<string, unknown>;
  event?: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
};

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function resolveTemplateString(template: string, scope: TemplateScope): unknown {
  const whole = WHOLE_TEMPLATE_RE.exec(template);
  if (whole && !whole[1]!.includes('}}')) {
    return evaluateExpression(whole[1]!, scope);
  }
  return template.replace(TEMPLATE_RE, (_m, expr: string) => stringify(evaluateExpression(expr, scope)));
}

export function resolveTemplates<T>(value: T, scope: TemplateScope, depth = 0): T {
  if (depth > MAX_DEPTH) throw new ExpressionError('Template nesting too deep');
  if (typeof value === 'string') {
    return (value.includes('{{') ? resolveTemplateString(value, scope) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplates(v, scope, depth + 1)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplates(v, scope, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Extract every expression embedded in templates within a value. */
export function extractTemplateExpressions(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TEMPLATE_RE)) acc.push(m[1]!);
  } else if (Array.isArray(value)) {
    value.forEach((v) => extractTemplateExpressions(v, acc));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((v) => extractTemplateExpressions(v, acc));
  }
  return acc;
}

/** Step keys referenced as `steps.<key>` from a set of expressions. */
export function referencedStepKeys(expressions: string[]): Set<string> {
  const keys = new Set<string>();
  for (const expr of expressions) {
    for (const path of collectPaths(expr)) {
      const parts = path.split('.');
      if (parts[0] === 'steps' && parts[1]) keys.add(parts[1]);
    }
  }
  return keys;
}
