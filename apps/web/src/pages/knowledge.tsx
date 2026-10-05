import { useRef, useState } from 'react';
import { BookOpenText, Database, FileUp, GitBranch, Globe, RefreshCw, Search, Sparkles, Ticket, Trash2, Type } from 'lucide-react';
import { KNOWLEDGE_SOURCE_TYPES } from '@forgeline/shared';
import { api } from '@/api/client';
import { useAction, useKnowledge, useKnowledgeStats, useProjects } from '@/api/queries';
import { useAuth } from '@/lib/auth';
import { formatNumber, timeAgo, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, Mono } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader, Stat } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';
import { Segmented } from '@/components/ui/tabs';
import { MarkdownView } from '@/components/ui/content';

type AddMode = 'text' | 'upload' | 'url' | 'github' | 'jira' | 'notion';

export function KnowledgePage() {
  useDocumentTitle('Knowledge');
  usePageContext({ title: 'Knowledge' });
  const { can } = useAuth();
  const stats = useKnowledgeStats();
  const [page, setPage] = useState(1);
  const [sourceType, setSourceType] = useState('');
  const [search, setSearch] = useState('');
  const docs = useKnowledge({ page, pageSize: 25, sourceType: sourceType || undefined, search: search || undefined });
  const [adding, setAdding] = useState<AddMode | null>(null);
  const manage = can('knowledge:manage');
  const inv = [['knowledge']];
  const reindex = useAction((id: string) => api.post(`/knowledge/documents/${id}/reindex`), {
    success: 'Re-indexing started',
    invalidate: inv,
  });
  const remove = useAction((id: string) => api.del(`/knowledge/documents/${id}`), {
    success: 'Document removed from the index',
    invalidate: inv,
  });
  const s = stats.data;

  return (
    <Page wide>
      <PageHeader
        title="Knowledge"
        description="Architecture docs, specs, APIs, tickets and code your agents retrieve as context (RAG). Retrieval is scoped to your workspace."
        actions={
          manage && (
            <>
              <Button icon={<GitBranch className="size-3.5" />} onClick={() => setAdding('github')}>
                Index repository
              </Button>
              <Button variant="primary" icon={<FileUp className="size-3.5" />} onClick={() => setAdding('upload')}>
                Add knowledge
              </Button>
            </>
          )
        }
      />
      {s && !s.embeddingsAvailable && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
          Embeddings are not configured (OPENAI_API_KEY). Documents can be stored but agents can’t retrieve them until an embedding model is
          available.
        </div>
      )}
      <Card className="mb-6 grid grid-cols-2 divide-line lg:grid-cols-4 lg:divide-x [&>*]:border-line max-lg:[&>*]:border-b">
        <Stat
          icon={<BookOpenText />}
          label="Documents"
          value={formatNumber(Object.values(s?.byStatus ?? {}).reduce((a, b) => a + b, 0))}
          hint={s ? `${s.byStatus.INDEXED ?? 0} indexed${s.byStatus.FAILED ? ` · ${s.byStatus.FAILED} failed` : ''}` : undefined}
        />
        <Stat
          icon={<Database />}
          label="Chunks"
          value={formatNumber(s?.chunks ?? 0)}
          hint={s ? `${formatNumber(s.tokens)} tokens` : undefined}
        />
        <Stat icon={<Sparkles />} label="Embedding model" value={<span className="text-[14px]">{s?.embeddingModel ?? '—'}</span>} />
        <Stat
          icon={<Database />}
          label="Vector store"
          value={
            <span className={s?.vectorStore.ok ? 'text-[14px] text-ok' : 'text-[14px] text-bad'}>
              {s ? (s.vectorStore.ok ? 'Healthy' : 'Unavailable') : '—'}
            </span>
          }
          hint={s?.vectorStore.message}
        />
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <div className="w-56">
              <Input
                icon={<Search className="size-3.5" />}
                placeholder="Filter by title…"
                value={search}
                onChange={(e) => (setSearch(e.target.value), setPage(1))}
              />
            </div>
            <Select value={sourceType} onChange={(e) => (setSourceType(e.target.value), setPage(1))} className="w-40" aria-label="Source">
              <option value="">All sources</option>
              {KNOWLEDGE_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </div>
          {docs.error ? (
            <div className="p-4">
              <ErrorState error={docs.error} />
            </div>
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Source</Th>
                    <Th>Status</Th>
                    <Th className="hidden text-right md:table-cell">Chunks</Th>
                    <Th className="text-right">Updated</Th>
                    {manage && <Th />}
                  </tr>
                </thead>
                <tbody>
                  {docs.isLoading && <TableSkeleton cols={manage ? 6 : 5} />}
                  {docs.data?.items.map((d) => (
                    <Tr key={d.id}>
                      <Td>
                        <div className="max-w-[360px] truncate font-medium">
                          {d.url ? (
                            <a href={d.url} target="_blank" rel="noreferrer" className="hover:text-accent">
                              {d.title}
                            </a>
                          ) : (
                            d.title
                          )}
                        </div>
                        <div className="text-[11.5px] text-fg-subtle">{d.documentType}</div>
                        {d.error && <div className="mt-0.5 line-clamp-1 text-[11.5px] text-bad">{d.error}</div>}
                      </Td>
                      <Td>
                        <Badge>{titleCase(d.sourceType)}</Badge>
                      </Td>
                      <Td>
                        <StatusBadge status={d.status} />
                      </Td>
                      <Td className="hidden text-right font-mono text-[12px] md:table-cell">{d.chunkCount}</Td>
                      <Td className="text-right text-[12px] text-fg-muted">{timeAgo(d.updatedAt)}</Td>
                      {manage && (
                        <Td className="text-right whitespace-nowrap">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Re-index"
                            onClick={() => reindex.mutate(d.id)}
                            icon={<RefreshCw className="size-3.5" />}
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Remove"
                            onClick={() => remove.mutate(d.id)}
                            icon={<Trash2 className="size-3.5" />}
                          />
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {docs.data && !docs.data.items.length && (
                <EmptyState
                  compact
                  icon={<BookOpenText />}
                  title="No knowledge yet"
                  description="Index a repository, import Jira tickets or Notion pages, or upload architecture docs. Agents ground specs, plans and code in it."
                  action={
                    manage && (
                      <Button size="sm" variant="primary" onClick={() => setAdding('upload')}>
                        Add knowledge
                      </Button>
                    )
                  }
                />
              )}
              {docs.data && <Pagination page={docs.data.page} pageSize={docs.data.pageSize} total={docs.data.total} onPage={setPage} />}
            </>
          )}
        </Card>
        <SearchBench />
      </div>
      {adding && <AddDialog initial={adding} onClose={() => setAdding(null)} />}
    </Page>
  );
}

function SearchBench() {
  const [query, setQuery] = useState('');
  const search = useAction(
    () =>
      api.post<{
        context: string;
        available: boolean;
        sources: { documentId: string; title: string; score: number; sourceType: string; url?: string | null; location?: string | null }[];
      }>('/knowledge/search', { query, k: 6 }),
    {},
  );
  return (
    <Card className="self-start">
      <CardHeader title="Test retrieval" description="See exactly which context an agent would receive for a question." />
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) search.mutate(undefined);
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How are refresh tokens stored?" />
        <Button type="submit" loading={search.isPending} disabled={query.trim().length < 2} icon={<Search className="size-3.5" />}>
          Search
        </Button>
      </form>
      {search.data && (
        <div className="space-y-3 border-t border-line p-3">
          {!search.data.sources.length ? (
            <p className="text-[12.5px] text-fg-subtle">{search.data.context}</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {search.data.sources.map((s, i) => (
                  <li key={`${s.documentId}-${i}`} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-5 font-mono text-[11px] text-fg-subtle">[{i + 1}]</span>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <Badge>{titleCase(s.sourceType)}</Badge>
                    <Mono>{(s.score * 100).toFixed(0)}%</Mono>
                  </li>
                ))}
              </ul>
              <div className="max-h-80 overflow-y-auto rounded-md border border-line bg-sunken p-3">
                <MarkdownView className="text-[12px]">{search.data.context}</MarkdownView>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function AddDialog({ initial, onClose }: { initial: AddMode; onClose: () => void }) {
  const projects = useProjects();
  const [mode, setMode] = useState<AddMode>(initial);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [documentType, setDocumentType] = useState('architecture');
  const [url, setUrl] = useState('');
  const [jql, setJql] = useState('project = AUTH ORDER BY updated DESC');
  const [notionQuery, setNotionQuery] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const inv = [['knowledge']];
  const submit = useAction(
    async () => {
      const project = projectId || undefined;
      switch (mode) {
        case 'text':
          return api.post('/knowledge/documents', { title, content, projectId: project, documentType });
        case 'upload': {
          const f = file.current?.files?.[0];
          if (!f) throw new Error('Choose a file');
          const form = new FormData();
          form.append('file', f);
          if (project) form.append('projectId', project);
          form.append('documentType', documentType);
          return api.upload('/knowledge/upload', form);
        }
        case 'url':
          return api.post('/knowledge/url', { url, projectId: project, documentType });
        case 'github':
          if (!project) throw new Error('Choose a project with a linked repository');
          return api.post('/knowledge/sources/github', { projectId: project, pathPrefix: pathPrefix || undefined });
        case 'jira':
          return api.post('/knowledge/sources/jira', { jql, projectId: project });
        case 'notion':
          return api.post('/knowledge/sources/notion', { query: notionQuery, projectId: project });
      }
    },
    { success: 'Ingestion started — documents are indexed in the background', invalidate: inv, onSuccess: onClose },
  );
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Add knowledge"
      description="Content is chunked, embedded and stored in your workspace’s isolated index."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate(undefined)}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'upload', label: 'Upload' },
            { value: 'text', label: 'Paste' },
            { value: 'url', label: 'URL' },
            { value: 'github', label: 'Repository' },
            { value: 'jira', label: 'Jira' },
            { value: 'notion', label: 'Notion' },
          ]}
        />
        <Field
          label="Project"
          hint={mode === 'github' ? 'The project’s linked repository is indexed' : 'Optional — scope retrieval to a project'}
        >
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{mode === 'github' ? 'Choose a project…' : 'Whole workspace'}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {(mode === 'text' || mode === 'upload' || mode === 'url') && (
          <Field label="Document type">
            <Select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              {['architecture', 'api', 'guideline', 'spec', 'runbook', 'adr', 'markdown'].map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {mode === 'upload' && (
          <Field label="File" hint="Markdown, text, JSON, YAML or source files up to 2 MB">
            <input
              ref={file}
              type="file"
              accept=".md,.markdown,.txt,.json,.yaml,.yml,.ts,.js,.py,.go,.java,.rb,.rs,.sql,.graphql,.proto"
              className="block w-full text-[12.5px] file:mr-3 file:rounded-md file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-[12px] file:text-fg"
            />
          </Field>
        )}
        {mode === 'text' && (
          <>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} icon={<Type className="size-3.5" />} />
            </Field>
            <Field label="Content (Markdown)">
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10} className="font-mono text-[12px]" />
            </Field>
          </>
        )}
        {mode === 'url' && (
          <Field label="URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.example.com/architecture"
              icon={<Globe className="size-3.5" />}
            />
          </Field>
        )}
        {mode === 'github' && (
          <Field label="Path prefix (optional)" hint="Index only part of the repository, e.g. docs/ or src/auth/">
            <Input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} className="font-mono text-[12px]" />
          </Field>
        )}
        {mode === 'jira' && (
          <Field label="JQL">
            <Input
              value={jql}
              onChange={(e) => setJql(e.target.value)}
              className="font-mono text-[12px]"
              icon={<Ticket className="size-3.5" />}
            />
          </Field>
        )}
        {mode === 'notion' && (
          <Field label="Search Notion pages">
            <Input value={notionQuery} onChange={(e) => setNotionQuery(e.target.value)} placeholder="Architecture" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
