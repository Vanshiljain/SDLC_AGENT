import { z } from 'zod';
import { defineTool, type AnySdlcTool } from '../core/tool';

export const slackPostMessage = defineTool({
  name: 'slack.postMessage',
  title: 'Post to Slack',
  description: 'Send a message to the team Slack channel via the connected incoming webhook.',
  category: 'notification',
  provider: 'SLACK',
  inputSchema: z.object({ text: z.string().min(1).max(3000), title: z.string().max(150).optional(), link: z.string().url().optional() }),
  permission: 'notify:send',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const slack = await ctx.clients.slack();
    const blocks = [
      ...(input.title ? [{ type: 'header', text: { type: 'plain_text', text: input.title.slice(0, 150) } }] : []),
      { type: 'section', text: { type: 'mrkdwn', text: input.text } },
      ...(input.link
        ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Forgeline' }, url: input.link }] }]
        : []),
    ];
    await slack.postMessage({ text: input.title ? `${input.title}\n${input.text}` : input.text, blocks });
    return { output: { delivered: true }, summary: 'Posted message to Slack' };
  },
  async simulate() {
    return { simulated: true, output: { delivered: true }, summary: '[Simulated] Posted message to Slack' };
  },
});

export const slackTools: AnySdlcTool[] = [slackPostMessage];
