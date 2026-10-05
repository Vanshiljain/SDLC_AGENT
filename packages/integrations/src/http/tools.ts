import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, type AnySdlcTool } from '../core/tool';
import { safeFetch } from './ssrf';

/** Generic HTTP Request node for the Flow builder (SSRF-protected). */
export function createHttpTools(options: { allowPrivateNetworks: boolean; allowedHosts?: string[] }): AnySdlcTool[] {
  const httpRequest = defineTool({
    name: 'http.request',
    title: 'HTTP request',
    description: 'Call an external HTTP endpoint (private networks blocked unless allowed by the administrator).',
    category: 'http',
    provider: null,
    inputSchema: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.unknown().optional(),
      expectStatus: z.number().int().optional(),
    }),
    permission: 'workflow:execute',
    risk: 'write',
    sideEffects: true,
    defaultTimeoutMs: 30_000,
    async execute(input) {
      const res = await safeFetch(
        input.url,
        {
          method: input.method,
          headers: { ...(input.body !== undefined && { 'Content-Type': 'application/json' }), ...input.headers },
          body: input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
          timeoutMs: 20_000,
        },
        options,
      );
      let json: unknown = null;
      try {
        json = res.body ? JSON.parse(res.body) : null;
      } catch {
        json = null;
      }
      const ok = input.expectStatus ? res.status === input.expectStatus : res.status < 400;
      if (!ok) {
        throw new ToolError(
          res.status >= 500 ? 'external' : 'validation',
          `HTTP ${input.method} ${new URL(input.url).host} returned ${res.status}`,
          { status: res.status },
        );
      }
      return {
        output: { status: res.status, body: json ?? res.body.slice(0, 10_000), latencyMs: res.latencyMs },
        summary: `${input.method} ${new URL(input.url).host} → ${res.status} (${res.latencyMs}ms)`,
      };
    },
  });
  return [httpRequest];
}
