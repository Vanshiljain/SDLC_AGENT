import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { invokeStructured, renderPrompt, UsageTracker, type LlmProvider, type ModelRole, type PromptKey } from '@forgeline/ai';
import type { ToolExecutionContext } from '@forgeline/integrations';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import { AgentRunsService } from '../ai/agent-runs.service';
import { RequestContext } from '../common/context/request-context';

/**
 * Runs one structured LLM task as an AgentRun: renders a versioned prompt,
 * calls the model with a zod schema, validates, records tokens/duration and
 * a concise decision summary (never hidden reasoning).
 */
@Injectable()
export class AgentTaskRunner {
  constructor(
    @Inject(LLM_PROVIDER) readonly llm: LlmProvider,
    private readonly agentRuns: AgentRunsService,
  ) {}

  async structured<S extends z.ZodType<Record<string, unknown>>>(p: {
    ctx: Pick<ToolExecutionContext, 'organizationId' | 'userId' | 'executionId' | 'signal' | 'logger'>;
    agent: string;
    task: string;
    prompt: PromptKey;
    variables: Record<string, unknown>;
    schema: S;
    schemaName: string;
    role: ModelRole;
    summarize?: (out: z.infer<S>) => string;
  }): Promise<{ output: z.infer<S>; agentRunId: string; usage: ReturnType<UsageTracker['snapshot']> }> {
    const usage = new UsageTracker();
    const run = await this.agentRuns.start({
      organizationId: p.ctx.organizationId,
      agentKey: p.agent,
      task: p.task,
      userId: p.ctx.userId,
      executionId: p.ctx.executionId ?? null,
      executionStepId: RequestContext.get().stepId ?? null,
    });
    try {
      const messages = await renderPrompt(p.prompt, p.variables);
      const output = await invokeStructured({
        model: this.llm.chatModel(p.role),
        schema: p.schema,
        name: p.schemaName,
        messages,
        usage,
        modelName: this.llm.modelName(p.role),
        signal: p.ctx.signal,
      });
      const summary = p.summarize?.(output) ?? p.task;
      await this.agentRuns.complete(p.ctx.organizationId, run, { usage, output, summary, model: this.llm.modelName(p.role), executionId: p.ctx.executionId });
      p.ctx.logger.info(`${p.task}: ${summary}`, { tokens: usage.totalTokens, model: this.llm.modelName(p.role) });
      return { output, agentRunId: run.id, usage: usage.snapshot() };
    } catch (err) {
      await this.agentRuns.fail(p.ctx.organizationId, run, err, usage);
      throw err;
    }
  }
}

/** Stringify structured values for prompts with a size cap. */
export function forPrompt(value: unknown, max = 12_000): string {
  if (value === undefined || value === null || value === '') return '(none)';
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… [truncated]` : s;
}
