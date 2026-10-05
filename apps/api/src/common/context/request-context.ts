import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation context propagated through async calls: request, workflow
 * execution, agent run and tool execution ids end up in every log line.
 */
export interface CorrelationContext {
  requestId?: string;
  userId?: string;
  organizationId?: string;
  executionId?: string;
  stepId?: string;
  agentRunId?: string;
  toolExecutionId?: string;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const RequestContext = {
  run<T>(ctx: CorrelationContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  get(): CorrelationContext {
    return storage.getStore() ?? {};
  },
  /** Mutate the current context (e.g. after authentication resolves the user). */
  set(values: Partial<CorrelationContext>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, values);
  },
};
