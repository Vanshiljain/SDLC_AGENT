import type { StepDefinition } from '@forgeline/shared';

/** DAG helpers over step definitions. */

export function stepMap(steps: StepDefinition[]): Map<string, StepDefinition> {
  return new Map(steps.map((s) => [s.key, s]));
}

/** Keys of steps used only as repair handlers (excluded from normal scheduling). */
export function repairStepKeys(steps: StepDefinition[]): Set<string> {
  const keys = new Set<string>();
  for (const s of steps) if (s.repair) keys.add(s.repair.step);
  return keys;
}

/**
 * Kahn topological sort. Returns ordered keys, or the keys participating in a
 * cycle when one exists.
 */
export function topologicalOrder(steps: StepDefinition[]): { order: string[]; cycle: string[] | null } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indegree.set(s.key, 0);
    dependents.set(s.key, []);
  }
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (!indegree.has(d)) continue;
      indegree.set(s.key, (indegree.get(s.key) ?? 0) + 1);
      dependents.get(d)!.push(s.key);
    }
  }
  // Stable order: preserve definition order among ready nodes.
  const position = new Map(steps.map((s, i) => [s.key, i]));
  const ready = steps.filter((s) => indegree.get(s.key) === 0).map((s) => s.key);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const key = ready.shift()!;
    order.push(key);
    for (const dep of dependents.get(key)!) {
      const n = indegree.get(dep)! - 1;
      indegree.set(dep, n);
      if (n === 0) ready.push(dep);
    }
  }
  if (order.length !== steps.length) {
    return { order, cycle: steps.map((s) => s.key).filter((k) => !order.includes(k)) };
  }
  return { order, cycle: null };
}

/** All transitive dependencies of a step. */
export function ancestors(steps: StepDefinition[], key: string): Set<string> {
  const map = stepMap(steps);
  const result = new Set<string>();
  const stack = [...(map.get(key)?.dependsOn ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (result.has(k)) continue;
    result.add(k);
    stack.push(...(map.get(k)?.dependsOn ?? []));
  }
  return result;
}

/** All transitive dependents of a step. */
export function descendants(steps: StepDefinition[], key: string): Set<string> {
  const result = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    for (const s of steps) {
      if (s.dependsOn.includes(k) && !result.has(s.key)) {
        result.add(s.key);
        stack.push(s.key);
      }
    }
  }
  return result;
}

/** Layer index (longest path from a root) for each step — used for layout. */
export function layers(steps: StepDefinition[]): Map<string, number> {
  const { order } = topologicalOrder(steps);
  const map = stepMap(steps);
  const depth = new Map<string, number>();
  for (const key of order) {
    const deps = map.get(key)!.dependsOn.filter((d) => depth.has(d));
    depth.set(key, deps.length ? Math.max(...deps.map((d) => depth.get(d)!)) + 1 : 0);
  }
  return depth;
}
