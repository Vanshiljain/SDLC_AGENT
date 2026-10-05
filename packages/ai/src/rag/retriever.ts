import { BaseRetriever, type BaseRetrieverInput } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { VectorSearchFilter, VectorStore, VectorPayload } from './vector-store';

/**
 * LangChain retriever over the tenant-scoped vector store. The tenant filter
 * is fixed at construction so a retriever can never leak across organizations.
 */
export interface KnowledgeRetrieverInput extends BaseRetrieverInput {
  store: VectorStore;
  embeddings: EmbeddingsInterface;
  filter: VectorSearchFilter;
  k?: number;
  scoreThreshold?: number;
}

export class KnowledgeRetriever extends BaseRetriever {
  override lc_namespace = ['forgeline', 'retrievers', 'knowledge'];
  private readonly store: VectorStore;
  private readonly embeddings: EmbeddingsInterface;
  private readonly filter: VectorSearchFilter;
  private readonly k: number;
  private readonly scoreThreshold?: number;

  constructor(fields: KnowledgeRetrieverInput) {
    super(fields);
    this.store = fields.store;
    this.embeddings = fields.embeddings;
    this.filter = fields.filter;
    this.k = fields.k ?? 8;
    this.scoreThreshold = fields.scoreThreshold;
  }

  override async _getRelevantDocuments(query: string): Promise<Document<VectorPayload & { score: number }>[]> {
    const vector = await this.embeddings.embedQuery(query);
    const hits = await this.store.search(vector, this.filter, this.k * 2, this.scoreThreshold);
    // De-duplicate overlapping chunks from the same document region.
    const seen = new Set<string>();
    const docs: Document<VectorPayload & { score: number }>[] = [];
    for (const hit of hits) {
      const key = `${hit.payload.documentId}:${Math.floor((hit.payload.startLine ?? hit.payload.chunkIndex) / 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push(new Document({ pageContent: hit.payload.text, metadata: { ...hit.payload, score: hit.score } }));
      if (docs.length >= this.k) break;
    }
    return docs;
  }
}

export interface ContextSource {
  documentId: string;
  title: string;
  sourceType: string;
  url: string | null;
  score: number;
  location: string | null;
}

/** Context assembly: number sources, respect a character budget, keep the best-scoring chunks. */
export function assembleContext(
  docs: Document<Partial<VectorPayload> & { score?: number }>[],
  maxChars = 12_000,
): { text: string; sources: ContextSource[] } {
  const sources: ContextSource[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const d of docs) {
    const m = d.metadata;
    const location = m.startLine ? `lines ${m.startLine}-${m.endLine}` : m.heading ?? null;
    const header = `[${sources.length + 1}] ${m.title ?? 'Untitled'}${location ? ` (${location})` : ''} — ${m.sourceType ?? 'doc'}`;
    const body = d.pageContent.trim();
    const block = `${header}\n${body}`;
    if (used + block.length > maxChars) {
      const remaining = maxChars - used - header.length - 20;
      if (remaining < 300) break;
      parts.push(`${header}\n${body.slice(0, remaining)}…`);
    } else {
      parts.push(block);
    }
    used += block.length;
    sources.push({ documentId: m.documentId ?? '', title: m.title ?? 'Untitled', sourceType: m.sourceType ?? 'doc', url: m.url ?? null, score: Number((m.score ?? 0).toFixed(3)), location });
  }
  return { text: parts.length ? parts.join('\n\n---\n\n') : 'No indexed knowledge matched this request.', sources };
}
