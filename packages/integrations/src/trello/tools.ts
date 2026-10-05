import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, idempotencyMarker, type AnySdlcTool, type ToolExecutionContext } from '../core/tool';
import { demoNumber } from '../core/helpers';

function listId(input: string | undefined, ctx: ToolExecutionContext, which: 'default' | 'done' = 'default'): string {
  const id = input ?? (which === 'done' ? ctx.project?.settings.trelloDoneListId : ctx.project?.settings.trelloListId);
  if (!id)
    throw new ToolError('not_configured', 'No Trello list configured for this project (settings.trelloListId)', { retryable: false });
  return id;
}

export const trelloCreateBoard = defineTool({
  name: 'trello.createBoard',
  title: 'Create Trello board',
  description: 'Create a Trello board with default lists.',
  category: 'trello',
  provider: 'TRELLO',
  inputSchema: z.object({ name: z.string().min(1).max(200) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    const boards = await trello.listBoards();
    const existing = boards.find((b) => b.name === input.name);
    const board = existing ?? (await trello.createBoard(input.name));
    const lists = await trello.listLists(board.id);
    return {
      output: { id: board.id, url: board.url, lists: lists.map((l) => ({ id: l.id, name: l.name })), created: !existing },
      summary: existing ? `Board "${input.name}" exists` : `Created board "${input.name}"`,
    };
  },
});

export const trelloCreateCard = defineTool({
  name: 'trello.createCard',
  title: 'Create Trello card',
  description: 'Create a card on a list (idempotent via an embedded reference marker).',
  category: 'trello',
  provider: 'TRELLO',
  agent: 'planning',
  inputSchema: z.object({
    listId: z.string().optional(),
    name: z.string().min(1).max(500),
    description: z.string().max(16_000).default(''),
  }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    const target = listId(input.listId, ctx);
    const marker = idempotencyMarker(ctx);
    const existing = (await trello.listCards(target)).find((c) => c.desc.includes(marker));
    const card =
      existing ??
      (await trello.createCard({ idList: target, name: input.name, desc: `${input.description}\n\n---\nForgeline-Ref: ${marker}` }));
    return {
      output: { id: card.id, url: card.shortUrl ?? card.url, name: card.name, created: !existing },
      summary: existing ? `Card "${card.name}" already exists` : `Created card "${card.name}"`,
      externalResources: [
        {
          provider: 'TRELLO',
          type: 'TRELLO_CARD',
          externalId: card.id,
          key: card.name.slice(0, 40),
          title: card.name,
          url: card.shortUrl ?? card.url,
        },
      ],
    };
  },
  async simulate(input, ctx) {
    const id = `demo-card-${demoNumber(ctx.idempotencyKey)}`;
    return {
      simulated: true,
      output: { id, url: null, name: input.name, created: true },
      summary: `[Simulated] Created card "${input.name}"`,
      externalResources: [{ provider: 'TRELLO', type: 'TRELLO_CARD', externalId: `${id}-${ctx.idempotencyKey}`, title: input.name }],
    };
  },
});

export const trelloUpdateCard = defineTool({
  name: 'trello.updateCard',
  title: 'Update Trello card',
  description: 'Update a card name or description.',
  category: 'trello',
  provider: 'TRELLO',
  inputSchema: z.object({
    cardId: z.string().min(1),
    name: z.string().max(500).optional(),
    description: z.string().max(16_000).optional(),
  }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    const card = await trello.updateCard(input.cardId, { name: input.name, desc: input.description });
    return { output: { id: card.id, url: card.shortUrl ?? card.url }, summary: `Updated card "${card.name}"` };
  },
});

export const trelloMoveCard = defineTool({
  name: 'trello.moveCard',
  title: 'Move Trello card',
  description: 'Move a card to another list (by list id or name on the same board).',
  category: 'trello',
  provider: 'TRELLO',
  inputSchema: z.object({ cardId: z.string().min(1), listId: z.string().optional(), listName: z.string().optional() }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    let target = input.listId;
    if (!target && input.listName) {
      const card = await trello.getCard(input.cardId);
      const lists = await trello.listLists(card.idBoard);
      target = lists.find((l) => l.name.toLowerCase() === input.listName!.toLowerCase())?.id;
      if (!target)
        throw new ToolError('validation', `List "${input.listName}" not found. Available: ${lists.map((l) => l.name).join(', ')}`, {
          retryable: false,
        });
    }
    target ??= listId(undefined, ctx, 'done');
    const card = await trello.updateCard(input.cardId, { idList: target });
    return { output: { id: card.id, listId: target }, summary: `Moved card "${card.name}"` };
  },
});

export const trelloAddComment = defineTool({
  name: 'trello.addComment',
  title: 'Comment on Trello card',
  description: 'Add a comment to a card (idempotent).',
  category: 'trello',
  provider: 'TRELLO',
  inputSchema: z.object({ cardId: z.string().min(1), text: z.string().min(1).max(16_000) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    const marker = idempotencyMarker(ctx);
    const dup = (await trello.listComments(input.cardId)).find((c) => c.data.text.includes(marker));
    if (dup) return { output: { id: dup.id }, summary: 'Comment already posted' };
    const c = await trello.addComment(input.cardId, `${input.text}\n\n(${marker})`);
    return { output: { id: c.id }, summary: 'Commented on card' };
  },
});

export const trelloAttachArtifact = defineTool({
  name: 'trello.attachArtifact',
  title: 'Attach link to Trello card',
  description: 'Attach a URL (PR, spec, deployment) to a card.',
  category: 'trello',
  provider: 'TRELLO',
  inputSchema: z.object({ cardId: z.string().min(1), url: z.string().url(), name: z.string().min(1).max(256) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const trello = await ctx.clients.trello();
    const existing = (await trello.listAttachments(input.cardId)).find((a) => a.url === input.url);
    const att = existing ?? (await trello.attachUrl(input.cardId, input.url, input.name));
    return { output: { id: att.id }, summary: `Attached "${input.name}"` };
  },
});

export const trelloTools: AnySdlcTool[] = [
  trelloCreateBoard,
  trelloCreateCard,
  trelloUpdateCard,
  trelloMoveCard,
  trelloAddComment,
  trelloAttachArtifact,
];
