import { HttpClient } from '../core/http';
import { blocksToMarkdown, markdownToBlocks, richText, type NotionBlock } from './blocks';

export interface NotionPage {
  id: string;
  url: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time?: string;
  properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
}

export const NOTION_VERSION = '2022-06-28';
const MAX_BLOCKS_PER_REQUEST = 100;

export class NotionClient {
  readonly http: HttpClient;

  constructor(options: { token: string; apiUrl?: string; fetchImpl?: typeof fetch }) {
    this.http = new HttpClient({
      baseUrl: options.apiUrl ?? 'https://api.notion.com/v1',
      provider: 'notion',
      fetchImpl: options.fetchImpl,
      defaultHeaders: { Authorization: `Bearer ${options.token}`, 'Notion-Version': NOTION_VERSION },
    });
  }

  me() {
    return this.http.get<{ id: string; name?: string; bot?: { workspace_name?: string } }>('/users/me');
  }

  static pageTitle(page: NotionPage): string {
    const titleProp = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
    return titleProp?.title?.map((t) => t.plain_text).join('') ?? 'Untitled';
  }

  async search(query: string, pageSize = 20): Promise<NotionPage[]> {
    const res = await this.http.post<{ results: NotionPage[] }>(
      '/search',
      {
        query,
        filter: { property: 'object', value: 'page' },
        page_size: pageSize,
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      },
      { retry: true },
    );
    return res.results;
  }

  getPage(pageId: string) {
    return this.http.get<NotionPage>(`/pages/${pageId}`);
  }

  async createPage(params: {
    parentPageId?: string;
    parentDatabaseId?: string;
    title: string;
    markdown: string;
    icon?: string;
  }): Promise<NotionPage> {
    const blocks = markdownToBlocks(params.markdown);
    const first = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
    const parent = params.parentDatabaseId ? { database_id: params.parentDatabaseId } : { page_id: params.parentPageId };
    const properties = params.parentDatabaseId ? { Name: { title: richText(params.title) } } : { title: { title: richText(params.title) } };
    const page = await this.http.post<NotionPage>('/pages', {
      parent,
      properties,
      children: first,
      ...(params.icon && { icon: { type: 'emoji', emoji: params.icon } }),
    });
    if (blocks.length > MAX_BLOCKS_PER_REQUEST) await this.appendBlocks(page.id, blocks.slice(MAX_BLOCKS_PER_REQUEST));
    return page;
  }

  async appendBlocks(blockId: string, blocks: NotionBlock[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      await this.http.patch(`/blocks/${blockId}/children`, { children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) });
    }
  }

  appendMarkdown(pageId: string, markdown: string) {
    return this.appendBlocks(pageId, markdownToBlocks(markdown));
  }

  async listBlocks(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.http.get<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(
        `/blocks/${blockId}/children`,
        {
          query: { page_size: 100, start_cursor: cursor },
        },
      );
      all.push(...res.results);
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor && all.length < 2000);
    return all;
  }

  async getPageMarkdown(pageId: string): Promise<{ title: string; markdown: string; url: string }> {
    const [page, blocks] = await Promise.all([this.getPage(pageId), this.listBlocks(pageId)]);
    return { title: NotionClient.pageTitle(page), markdown: blocksToMarkdown(blocks), url: page.url };
  }

  updatePageTitle(pageId: string, title: string) {
    return this.http.patch<NotionPage>(`/pages/${pageId}`, { properties: { title: { title: richText(title) } } });
  }

  /** Replace page content: archive existing child blocks and append new ones. */
  async replaceContent(pageId: string, markdown: string): Promise<void> {
    const existing = await this.listBlocks(pageId);
    for (const b of existing) {
      if (b.id) await this.http.delete(`/blocks/${b.id}`, { allowStatus: [404] });
    }
    await this.appendMarkdown(pageId, markdown);
  }

  archivePage(pageId: string) {
    return this.http.patch<NotionPage>(`/pages/${pageId}`, { archived: true });
  }
}
