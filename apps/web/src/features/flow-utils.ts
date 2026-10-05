import type { StepDefinition } from '@forgeline/shared';

/** Pure helpers for the flow builder (unit-tested). */

export function uniqueKey(base: string, steps: StepDefinition[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1').slice(0, 50) || 'step';
  let key = clean;
  for (let i = 2; steps.some((s) => s.key === key); i++) key = `${clean}_${i}`;
  return key;
}

export function wouldCycle(steps: StepDefinition[], source: string, target: string): boolean {
  // Adding source → target creates a cycle if target already reaches source.
  const deps = new Map(steps.map((s) => [s.key, s.dependsOn]));
  const stack = [source];
  const seen = new Set<string>();
  while (stack.length) {
    const k = stack.pop()!;
    if (k === target) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(deps.get(k) ?? []));
  }
  return false;
}

export function ancestors(steps: StepDefinition[], key: string): string[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const out = new Set<string>();
  const stack = [...(byKey.get(key)?.dependsOn ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    out.add(k);
    stack.push(...(byKey.get(k)?.dependsOn ?? []));
  }
  return [...out];
}
