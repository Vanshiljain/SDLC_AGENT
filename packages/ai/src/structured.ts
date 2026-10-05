import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import type { UsageTracker } from './usage';

/**
 * Invoke a chat model with a zod schema as structured output. Validates the
 * result, retries once with the validation error fed back to the model, and
 * records token usage. Never returns unvalidated data.
 */
export async function invokeStructured<S extends z.ZodType<Record<string, unknown>>>(params: {
  model: BaseChatModel;
  schema: S;
  name: string;
  messages: BaseMessage[];
  usage?: UsageTracker;
  modelName?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<z.infer<S>> {
  const { model, schema, name, usage } = params;
  const runnable = model.withStructuredOutput(schema, { name, method: 'jsonSchema', includeRaw: true });
  const messages = [...params.messages];
  const attempts = params.maxAttempts ?? 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: { raw: BaseMessage; parsed: unknown };
    try {
      result = (await runnable.invoke(messages, { signal: params.signal })) as { raw: BaseMessage; parsed: unknown };
    } catch (err) {
      throw classifyLlmError(err);
    }
    usage?.record(result.raw, params.modelName);
    const parsed = schema.safeParse(result.parsed);
    if (parsed.success) return parsed.data;
    lastError = parsed.error;
    messages.push(
      new HumanMessage(
        `Your previous output did not match the required schema "${name}". Errors: ${parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}. Return a corrected, complete result.`,
      ),
    );
  }
  throw new ToolError('malformed_response', `Model output for "${name}" failed validation: ${(lastError as Error)?.message ?? 'unknown'}`, {
    provider: 'llm',
    retryable: true,
  });
}

/** Map OpenAI/LangChain errors to ToolErrors so the engine can retry sensibly. */
export function classifyLlmError(err: unknown): ToolError {
  if (ToolError.is(err)) return err;
  const e = err as { status?: number; code?: string; name?: string; message?: string; lc_error_code?: string };
  const status = e.status;
  const message = e.message ?? String(err);
  if (e.name === 'AbortError' || /aborted/i.test(message))
    return new ToolError('cancelled', 'LLM call cancelled', { provider: 'llm', retryable: false });
  if (status === 401) return new ToolError('auth', 'LLM provider rejected the API key', { provider: 'llm', status, retryable: false });
  if (status === 403)
    return new ToolError('permission', `LLM provider denied the request: ${message}`, { provider: 'llm', status, retryable: false });
  if (status === 429 || e.lc_error_code === 'MODEL_RATE_LIMIT') {
    const quota = /quota|billing/i.test(message);
    return new ToolError('rate_limit', `LLM rate limited: ${message}`, { provider: 'llm', status, retryable: !quota });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ToolError('validation', `LLM request invalid: ${message}`, { provider: 'llm', status, retryable: false });
  }
  if (status && status >= 500) return new ToolError('external', `LLM provider error: ${message}`, { provider: 'llm', status });
  if (/timeout|timed out/i.test(message)) return new ToolError('timeout', 'LLM call timed out', { provider: 'llm' });
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(message))
    return new ToolError('network', `LLM network error: ${message}`, { provider: 'llm' });
  return new ToolError('external', `LLM call failed: ${message}`, { provider: 'llm', retryable: false });
}
