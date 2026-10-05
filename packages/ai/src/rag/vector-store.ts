import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Vector store port. Qdrant is the default implementation; another store
 * (pgvector, Pinecone…) only needs to implement this interface.
 */

export interface VectorPayload {
  organizationId: string;
  projectId: string | null;
  repositoryId: string | null;
  documentId: string;
  documentType: string;
  sourceType: string;
  source: string;
  title: string;
  chunkIndex: number;
  text: string;
  startLine: number | null;
  endLine: number | null;
  heading: string | null;
  branch: string | null;
  environment: string | null;
  url: string | null;
  indexedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

export interface VectorSearchFilter {
  /** Mandatory tenant filter. */
  organizationId: string;
  /** When set, matches the project's documents AND organization-wide documents (projectId null). */
  projectId?: string | null;
  projectOnly?: boolean;
  repositoryId?: string;
  documentTypes?: string[];
  sourceTypes?: string[];
  branch?: string;
  environment?: string;
  documentIds?: string[];
}

export interface VectorSearchHit {
  id: string;
  score: number;
  payload: VectorPayload;
}

export interface VectorStore {
  readonly name: string;
  ensureCollection(dimensions: number): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  deleteDocument(organizationId: string, documentId: string): Promise<void>;
  search(vector: number[], filter: VectorSearchFilter, limit: number, scoreThreshold?: number): Promise<VectorSearchHit[]>;
  health(): Promise<{ ok: boolean; message?: string }>;
}

type QdrantCondition = Record<string, unknown>;

export function buildQdrantFilter(filter: VectorSearchFilter): { must: QdrantCondition[]; should?: QdrantCondition[]; min_should?: unknown } {
  if (!filter.organizationId) throw new Error('organizationId filter is mandatory for vector search');
  const must: QdrantCondition[] = [{ key: 'organizationId', match: { value: filter.organizationId } }];
  if (filter.projectId) {
    if (filter.projectOnly) {
      must.push({ key: 'projectId', match: { value: filter.projectId } });
    } else {
      must.push({
        should: [{ key: 'projectId', match: { value: filter.projectId } }, { is_null: { key: 'projectId' } }],
      });
    }
  }
  if (filter.repositoryId) must.push({ key: 'repositoryId', match: { value: filter.repositoryId } });
  if (filter.documentTypes?.length) must.push({ key: 'documentType', match: { any: filter.documentTypes } });
  if (filter.sourceTypes?.length) must.push({ key: 'sourceType', match: { any: filter.sourceTypes } });
  if (filter.branch) must.push({ key: 'branch', match: { value: filter.branch } });
  if (filter.environment) must.push({ key: 'environment', match: { value: filter.environment } });
  if (filter.documentIds?.length) must.push({ key: 'documentId', match: { any: filter.documentIds } });
  return { must };
}

const KEYWORD_INDEXES = ['projectId', 'repositoryId', 'documentId', 'documentType', 'sourceType', 'branch', 'environment'];

export class QdrantVectorStore implements VectorStore {
  readonly name = 'qdrant';
  private readonly client: QdrantClient;
  private ensured = false;

  constructor(
    private readonly options: { url: string; apiKey?: string; collection: string; timeoutMs?: number },
  ) {
    this.client = new QdrantClient({ url: options.url, apiKey: options.apiKey || undefined, timeout: options.timeoutMs ?? 30_000, checkCompatibility: false });
  }

  async ensureCollection(dimensions: number): Promise<void> {
    if (this.ensured) return;
    const { exists } = await this.client.collectionExists(this.options.collection);
    if (!exists) {
      await this.client.createCollection(this.options.collection, {
        vectors: { size: dimensions, distance: 'Cosine' },
        on_disk_payload: true,
        hnsw_config: { payload_m: 16, m: 0 },
      });
      // Multitenancy: organizationId is a tenant index (per-tenant HNSW graphs).
      await this.client.createPayloadIndex(this.options.collection, {
        field_name: 'organizationId',
        field_schema: { type: 'keyword', is_tenant: true },
        wait: true,
      });
      for (const field of KEYWORD_INDEXES) {
        await this.client.createPayloadIndex(this.options.collection, { field_name: field, field_schema: 'keyword', wait: true });
      }
    } else {
      const info = await this.client.getCollection(this.options.collection);
      const vectors = info.config.params.vectors as { size?: number } | undefined;
      if (vectors?.size && vectors.size !== dimensions) {
        throw new Error(
          `Qdrant collection "${this.options.collection}" has dimension ${vectors.size} but the embedding model produces ${dimensions}. Use a new QDRANT_COLLECTION or re-create the collection.`,
        );
      }
    }
    this.ensured = true;
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += 128) {
      const batch = points.slice(i, i + 128);
      await this.client.upsert(this.options.collection, {
        wait: true,
        points: batch.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload as unknown as Record<string, unknown> })),
      });
    }
  }

  async deleteDocument(organizationId: string, documentId: string): Promise<void> {
    await this.client.delete(this.options.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'organizationId', match: { value: organizationId } },
          { key: 'documentId', match: { value: documentId } },
        ],
      },
    });
  }

  async search(vector: number[], filter: VectorSearchFilter, limit: number, scoreThreshold?: number): Promise<VectorSearchHit[]> {
    const res = await this.client.query(this.options.collection, {
      query: vector,
      limit,
      filter: buildQdrantFilter(filter) as never,
      with_payload: true,
      ...(scoreThreshold !== undefined && { score_threshold: scoreThreshold }),
    });
    return res.points.map((r) => ({ id: String(r.id), score: r.score, payload: r.payload as unknown as VectorPayload }));
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      const { exists } = await this.client.collectionExists(this.options.collection);
      return { ok: true, message: exists ? `collection ${this.options.collection} ready` : 'collection not created yet' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
