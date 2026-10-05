import { Global, Module } from '@nestjs/common';
import { OpenAiLlmProvider, QdrantVectorStore, type LlmProvider, type VectorStore } from '@forgeline/ai';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { LLM_PROVIDER, VECTOR_STORE } from '../knowledge/knowledge.tokens';
import { AgentRunsService } from './agent-runs.service';

/**
 * Provider wiring for the AI layer. Swap OpenAiLlmProvider / QdrantVectorStore
 * for another implementation of LlmProvider / VectorStore here.
 */
@Global()
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): LlmProvider =>
        new OpenAiLlmProvider({
          apiKey: c.ai.apiKey,
          baseUrl: c.ai.baseUrl,
          organization: c.ai.organization,
          model: c.ai.model,
          roleModels: { orchestrator: c.ai.model, planner: c.ai.roleModels.planner, coder: c.ai.roleModels.coder, reviewer: c.ai.roleModels.reviewer, fast: c.ai.roleModels.fast },
          embeddingModel: c.ai.embeddingModel,
          embeddingDimensions: c.ai.embeddingDimensions,
          temperature: c.ai.temperature,
          timeoutMs: c.ai.timeoutMs,
          maxRetries: c.ai.maxRetries,
        }),
    },
    {
      provide: VECTOR_STORE,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): VectorStore => new QdrantVectorStore({ url: c.qdrant.url, apiKey: c.qdrant.apiKey, collection: c.qdrant.collection }),
    },
    AgentRunsService,
  ],
  exports: [LLM_PROVIDER, VECTOR_STORE, AgentRunsService],
})
export class AiModule {}
