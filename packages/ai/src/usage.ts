import type { AIMessage, BaseMessage } from '@langchain/core/messages';

/** Aggregates token usage across LLM calls for AgentRun accounting. */
export class UsageTracker {
  promptTokens = 0;
  completionTokens = 0;
  calls = 0;
  readonly models = new Set<string>();

  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  record(message: BaseMessage | AIMessage | null | undefined, model?: string): void {
    this.calls++;
    if (model) this.models.add(model);
    const usage = (message as AIMessage | undefined)?.usage_metadata;
    if (usage) {
      this.promptTokens += usage.input_tokens ?? 0;
      this.completionTokens += usage.output_tokens ?? 0;
      return;
    }
    const legacy = (message?.response_metadata as { tokenUsage?: { promptTokens?: number; completionTokens?: number } } | undefined)?.tokenUsage;
    if (legacy) {
      this.promptTokens += legacy.promptTokens ?? 0;
      this.completionTokens += legacy.completionTokens ?? 0;
    }
  }

  merge(other: UsageTracker): void {
    this.promptTokens += other.promptTokens;
    this.completionTokens += other.completionTokens;
    this.calls += other.calls;
    other.models.forEach((m) => this.models.add(m));
  }

  snapshot() {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      calls: this.calls,
      models: [...this.models],
    };
  }
}
