import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { createHttpTools, integrationTools, type AnySdlcTool } from '@forgeline/integrations';
import type { IntegrationProvider, NodeCategory } from '@forgeline/shared';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  category: NodeCategory;
  provider: IntegrationProvider | null;
  agent: string | null;
  risk: string;
  sideEffects: boolean;
  permission: string;
  approvalAction: string | null;
  supportsDemo: boolean;
  polling: boolean;
  inputSchema: Record<string, unknown>;
}

/** Registry of every AI-/Flow-callable tool (integration adapters + platform tools). */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, AnySdlcTool>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    for (const t of [...integrationTools, ...createHttpTools({ allowPrivateNetworks: config.outbound.allowPrivateNetworks, allowedHosts: config.outbound.allowedHosts })]) {
      this.register(t);
    }
  }

  register(tool: AnySdlcTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool registration: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnySdlcTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): AnySdlcTool[] {
    return [...this.tools.values()];
  }

  describe(tool: AnySdlcTool): ToolDescriptor {
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = z.toJSONSchema(tool.inputSchema as z.ZodType, { unrepresentable: 'any' }) as Record<string, unknown>;
    } catch {
      inputSchema = { type: 'object' };
    }
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      provider: tool.provider,
      agent: tool.agent ?? null,
      risk: tool.risk,
      sideEffects: tool.sideEffects,
      permission: typeof tool.permission === 'string' ? tool.permission : 'dynamic',
      approvalAction: typeof tool.approvalAction === 'string' ? tool.approvalAction : tool.approvalAction ? 'dynamic' : null,
      supportsDemo: Boolean(tool.simulate),
      polling: Boolean(tool.maxPollDurationMs),
      inputSchema,
    };
  }

  catalog(): ToolDescriptor[] {
    return this.all().map((t) => this.describe(t)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  /** Compact catalog text for LLM prompts. */
  promptCatalog(filter?: (t: AnySdlcTool) => boolean): string {
    return this.all()
      .filter((t) => (filter ? filter(t) : true))
      .map((t) => {
        const schema = this.describe(t).inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
        const fields = Object.entries(schema.properties ?? {})
          .map(([k, v]) => `${k}${schema.required?.includes(k) ? '' : '?'}:${v.type ?? 'any'}`)
          .join(', ');
        return `- ${t.name} — ${t.description} Input: {${fields}}`;
      })
      .join('\n');
  }
}
