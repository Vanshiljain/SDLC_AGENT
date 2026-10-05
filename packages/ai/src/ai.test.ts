import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { Document } from '@langchain/core/documents';
import { chunkContent, chunkPointId, contentHash, detectKind, looksBinary } from './rag/chunking';
import { buildQdrantFilter, QdrantVectorStore } from './rag/vector-store';
import { assembleContext, KnowledgeRetriever } from './rag/retriever';
import { classifyLlmError } from './structured';
import { renderPrompt, listPrompts } from './prompts/registry';
import { OpenAiLlmProvider } from './provider';

describe('chunking', () => {
  it('detects content kinds', () => {
    expect(detectKind('src/auth/auth.service.ts')).toEqual({ kind: 'code', language: 'js' });
    expect(detectKind('docs/ARCH.md')).toEqual({ kind: 'markdown', language: 'markdown' });
    expect(detectKind('schema.prisma').kind).toBe('code');
    expect(detectKind(undefined).kind).toBe('text');
  });

  it('splits code with line ranges and symbol headings', async () => {
    const code = Array.from({ length: 80 }, (_, i) => `export function handler${i}(req: Request) {\n  return validate(req.body.field${i});\n}\n`).join('\n');
    const chunks = await chunkContent(code, { kind: 'code', language: 'js', chunkSize: 600 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[1]!.startLine).toBeGreaterThan(1);
    expect(chunks.at(-1)!.endLine).toBeGreaterThan(200);
    expect(chunks[2]!.heading).toMatch(/^handler\d+$/);
  });

  it('tracks markdown headings', async () => {
    const md = `# Auth\n\nIntro.\n\n## Password reset\n\n${'Tokens expire after 30 minutes. '.repeat(80)}`;
    const chunks = await chunkContent(md, { kind: 'markdown', language: 'markdown', chunkSize: 500 });
    expect(chunks.at(-1)!.heading).toBe('Password reset');
  });

  it('produces deterministic UUID point ids and content hashes', () => {
    const id = chunkPointId('doc-1', 3);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkPointId('doc-1', 3)).toBe(id);
    expect(chunkPointId('doc-1', 4)).not.toBe(id);
    expect(contentHash('a\r\nb ')).toBe(contentHash('a\nb'));
    expect(looksBinary('\u0000\u0001\u0002\u0003abc')).toBe(true);
  });
});

describe('vector filters', () => {
  it('always scopes by tenant and includes org-wide docs for a project', () => {
    const f = buildQdrantFilter({ organizationId: 'o1', projectId: 'p1', documentTypes: ['code'] });
    expect(f.must[0]).toEqual({ key: 'organizationId', match: { value: 'o1' } });
    expect(JSON.stringify(f.must[1])).toContain('is_null');
    expect(f.must[2]).toEqual({ key: 'documentType', match: { any: ['code'] } });
    expect(() => buildQdrantFilter({ organizationId: '' })).toThrow();
  });
});

describe('context assembly', () => {
  it('numbers sources and respects the budget', () => {
    const docs = [1, 2, 3].map(
      (i) => new Document({ pageContent: 'x'.repeat(1000), metadata: { documentId: `d${i}`, title: `Doc ${i}`, sourceType: 'GITHUB', score: 0.9 - i / 10, startLine: 1, endLine: 20 } }),
    );
    const { text, sources } = assembleContext(docs, 2300);
    expect(text).toContain('[1] Doc 1 (lines 1-20)');
    expect(sources.length).toBe(2);
  });
});

describe('LLM error classification', () => {
  it('maps provider errors to tool error kinds', () => {
    expect(classifyLlmError({ status: 401, message: 'bad key' }).kind).toBe('auth');
    expect(classifyLlmError({ status: 429, message: 'slow down' })).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(classifyLlmError({ status: 429, message: 'You exceeded your current quota' })).toMatchObject({ kind: 'rate_limit', retryable: false });
    expect(classifyLlmError({ status: 503, message: 'overloaded' })).toMatchObject({ kind: 'external', retryable: true });
    expect(classifyLlmError(new Error('Request timed out'))).toMatchObject({ kind: 'timeout' });
  });

  it('refuses to build models without an API key', () => {
    const p = new OpenAiLlmProvider({ model: 'gpt-4.1', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, timeoutMs: 1000, maxRetries: 0 });
    expect(p.isConfigured()).toBe(false);
    expect(() => p.chatModel('coder')).toThrow(/not configured/);
  });

  it('resolves per-role model names from configuration', () => {
    const p = new OpenAiLlmProvider({ apiKey: 'k', model: 'base-model', roleModels: { coder: 'code-model' }, embeddingModel: 'e', embeddingDimensions: 8, timeoutMs: 1000, maxRetries: 0 });
    expect(p.modelName('coder')).toBe('code-model');
    expect(p.modelName('planner')).toBe('base-model');
  });
});

describe('prompts', () => {
  it('renders templates with brace-heavy content passed as variables', async () => {
    const messages = await renderPrompt('codeGenerate', {
      plan: '{"steps": []}',
      files: 'const x = { a: 1 };',
      context: 'NestJS',
      requirement: 'Add {{ template }} support',
    });
    expect(messages).toHaveLength(2);
    expect(String(messages[1]!.content)).toContain('Add {{ template }} support');
    expect(listPrompts().length).toBeGreaterThan(10);
  });
});

/** Deterministic fake embeddings: bag-of-words hashed into a small vector. */
class HashEmbeddings implements EmbeddingsInterface {
  constructor(private readonly dims = 64) {}
  private embed(text: string): number[] {
    const v = new Array(this.dims).fill(0);
    for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % this.dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.embed(t));
  }
  async embedQuery(text: string) {
    return this.embed(text);
  }
}

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const qdrantAvailable = await fetch(QDRANT_URL).then((r) => r.ok).catch(() => false);

describe.runIf(qdrantAvailable)('Qdrant vector store (live)', () => {
  it('upserts, filters by tenant/project and retrieves via the LangChain retriever', async () => {
    const collection = `test_${randomUUID().slice(0, 8)}`;
    const store = new QdrantVectorStore({ url: QDRANT_URL, collection });
    const embeddings = new HashEmbeddings(512);
    await store.ensureCollection(512);
    const base = { repositoryId: null, documentType: 'architecture', sourceType: 'UPLOAD', source: 'test', startLine: null, endLine: null, heading: null, branch: null, environment: null, url: null, indexedAt: new Date().toISOString() };
    const texts = [
      { org: 'org-a', project: 'p1', doc: 'd1', text: 'password reset tokens are stored hashed and expire after thirty minutes' },
      { org: 'org-a', project: null, doc: 'd2', text: 'all services use structured logging with request ids' },
      { org: 'org-b', project: 'p9', doc: 'd3', text: 'password reset secret plans of another tenant' },
      { org: 'org-a', project: 'p2', doc: 'd4', text: 'billing service invoices password reset unrelated project' },
    ];
    const vectors = await embeddings.embedDocuments(texts.map((t) => t.text));
    await store.upsert(texts.map((t, i) => ({ id: chunkPointId(t.doc, 0), vector: vectors[i]!, payload: { ...base, organizationId: t.org, projectId: t.project, documentId: t.doc, title: t.doc, chunkIndex: 0, text: t.text } })));

    const retriever = new KnowledgeRetriever({ store, embeddings, filter: { organizationId: 'org-a', projectId: 'p1' }, k: 5 });
    const docs = await retriever.invoke('password reset tokens expire');
    const ids = docs.map((d) => d.metadata.documentId);
    expect(ids[0]).toBe('d1');
    expect(ids).toContain('d2');
    expect(ids).not.toContain('d3');
    expect(ids).not.toContain('d4');

    await store.deleteDocument('org-a', 'd1');
    const after = await retriever.invoke('password reset');
    expect(after.map((d) => d.metadata.documentId)).not.toContain('d1');
    expect((await store.health()).ok).toBe(true);
  }, 30_000);
});
