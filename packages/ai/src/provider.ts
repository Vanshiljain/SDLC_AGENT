import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ToolError } from '@forgeline/shared';

/**
 * LLM provider abstraction. The rest of the platform asks for a model by
 * *role*; which concrete model serves a role is configuration. OpenAI is the
 * default implementation, but any LangChain chat model can be plugged in by
 * implementing LlmProvider.
 */
export const MODEL_ROLES = ['orchestrator', 'planner', 'coder', 'reviewer', 'fast'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  /** Default chat model (OPENAI_MODEL). */
  model: string;
  /** Optional per-role overrides (OPENAI_MODEL_CODER, …). */
  roleModels?: Partial<Record<ModelRole, string>>;
  embeddingModel: string;
  embeddingDimensions: number;
  temperature?: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface ChatModelOptions {
  streaming?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  modelName(role: ModelRole): string;
  chatModel(role: ModelRole, options?: ChatModelOptions): BaseChatModel;
  embeddings(): EmbeddingsInterface;
  readonly embeddingDimensions: number;
  readonly embeddingModelName: string;
}

/** Reasoning models reject sampling parameters such as temperature. */
function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model);
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai';
  private embeddingsInstance?: EmbeddingsInterface;

  constructor(private readonly config: AiConfig) {}

  get embeddingDimensions(): number {
    return this.config.embeddingDimensions;
  }
  get embeddingModelName(): string {
    return this.config.embeddingModel;
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ToolError('not_configured', 'AI provider is not configured: set OPENAI_API_KEY (and optionally OPENAI_BASE_URL)', {
        retryable: false,
        provider: 'openai',
      });
    }
  }

  modelName(role: ModelRole): string {
    return this.config.roleModels?.[role] ?? this.config.model;
  }

  chatModel(role: ModelRole, options: ChatModelOptions = {}): BaseChatModel {
    this.assertConfigured();
    const model = this.modelName(role);
    const temperature = options.temperature ?? this.config.temperature;
    return new ChatOpenAI({
      model,
      apiKey: this.config.apiKey,
      ...(temperature !== undefined && supportsTemperature(model) ? { temperature } : {}),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      streaming: options.streaming ?? false,
      streamUsage: true,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      configuration: {
        ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        ...(this.config.organization ? { organization: this.config.organization } : {}),
      },
    });
  }

  embeddings(): EmbeddingsInterface {
    this.assertConfigured();
    this.embeddingsInstance ??= new OpenAIEmbeddings({
      model: this.config.embeddingModel,
      apiKey: this.config.apiKey,
      ...(this.config.embeddingModel.startsWith('text-embedding-3') ? { dimensions: this.config.embeddingDimensions } : {}),
      batchSize: 256,
      maxRetries: this.config.maxRetries,
      timeout: this.config.timeoutMs,
      configuration: this.config.baseUrl ? { baseURL: this.config.baseUrl } : undefined,
    });
    return this.embeddingsInstance;
  }
}
