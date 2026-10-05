import { HttpClient } from '../core/http';

/** Trello REST API client (key + user token). */
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idBoard: string;
  url: string;
  shortUrl: string;
  closed: boolean;
}
export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}
export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  closed: boolean;
}

export class TrelloClient {
  readonly http: HttpClient;

  constructor(options: { apiKey: string; token: string; apiUrl?: string; fetchImpl?: typeof fetch }) {
    const { apiKey, token } = options;
    this.http = new HttpClient({
      baseUrl: options.apiUrl ?? 'https://api.trello.com/1',
      provider: 'trello',
      fetchImpl: options.fetchImpl,
      // Trello's documented header form avoids credentials in URLs/logs.
      defaultHeaders: { Authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"` },
    });
  }

  me() {
    return this.http.get<{ id: string; username: string; fullName: string }>('/members/me', { query: { fields: 'username,fullName' } });
  }
  listBoards() {
    return this.http.get<TrelloBoard[]>('/members/me/boards', { query: { filter: 'open', fields: 'name,url,closed' } });
  }
  createBoard(name: string, defaultLists = true) {
    return this.http.post<TrelloBoard>('/boards/', undefined, { query: { name, defaultLists } });
  }
  listLists(boardId: string) {
    return this.http.get<TrelloList[]>(`/boards/${boardId}/lists`, { query: { filter: 'open' } });
  }
  listCards(listId: string) {
    return this.http.get<TrelloCard[]>(`/lists/${listId}/cards`, { query: { fields: 'name,desc,idList,idBoard,url,shortUrl,closed' } });
  }
  getCard(cardId: string) {
    return this.http.get<TrelloCard>(`/cards/${cardId}`);
  }
  createCard(params: { idList: string; name: string; desc?: string; pos?: 'top' | 'bottom' }) {
    return this.http.post<TrelloCard>('/cards', undefined, {
      query: { idList: params.idList, name: params.name, desc: params.desc, pos: params.pos ?? 'top' },
    });
  }
  updateCard(cardId: string, patch: { name?: string; desc?: string; idList?: string; closed?: boolean }) {
    return this.http.put<TrelloCard>(`/cards/${cardId}`, undefined, { query: patch });
  }
  addComment(cardId: string, text: string) {
    return this.http.post<{ id: string }>(`/cards/${cardId}/actions/comments`, undefined, { query: { text } });
  }
  listComments(cardId: string) {
    return this.http.get<{ id: string; data: { text: string } }[]>(`/cards/${cardId}/actions`, { query: { filter: 'commentCard' } });
  }
  attachUrl(cardId: string, url: string, name: string) {
    return this.http.post<{ id: string; url: string }>(`/cards/${cardId}/attachments`, undefined, { query: { url, name } });
  }
  listAttachments(cardId: string) {
    return this.http.get<{ id: string; url: string; name: string }[]>(`/cards/${cardId}/attachments`);
  }
  createWebhook(callbackURL: string, idModel: string, description: string) {
    return this.http.post<{ id: string }>('/webhooks', undefined, { query: { callbackURL, idModel, description } });
  }
}
