import { ToolError } from '@forgeline/shared';
import { safeFetch } from '../http/ssrf';

/** Slack incoming-webhook client for team notifications. */
export class SlackClient {
  constructor(
    private readonly webhookUrl: string,
    private readonly options: { allowPrivateNetworks?: boolean } = {},
  ) {
    if (!options.allowPrivateNetworks && !/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
      throw new ToolError('validation', 'Slack webhook URL must be a https://hooks.slack.com/ URL', { retryable: false });
    }
  }

  async postMessage(message: { text: string; blocks?: unknown[] }): Promise<void> {
    const res = await safeFetch(
      this.webhookUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message), timeoutMs: 10_000 },
      { allowPrivateNetworks: Boolean(this.options.allowPrivateNetworks) },
    );
    if (res.status === 429) throw new ToolError('rate_limit', 'Slack rate limited the webhook', { provider: 'slack', status: 429 });
    if (res.status >= 400) {
      throw new ToolError(
        res.status >= 500 ? 'external' : res.status === 404 || res.status === 403 ? 'auth' : 'validation',
        `Slack webhook returned ${res.status}: ${res.body.slice(0, 200)}`,
        { provider: 'slack', status: res.status },
      );
    }
  }
}
