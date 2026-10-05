import { createHmac } from 'node:crypto';
import { HttpClient } from '../core/http';
import type { CiCdEnvironment, CiCdProvider, DeployRequest, DeploymentHandle, PipelineRequest, PipelineRun, RollbackRequest } from './cicd';

/**
 * Adapter for Forgeline's own DevOps platform (or any service implementing the
 * documented REST contract in docs/INTEGRATIONS.md).
 *
 * Requests carry a bearer token plus an HMAC-SHA256 signature over
 * `${timestamp}.${body}` so the DevOps service can verify integrity and reject
 * replays; mutating calls include an Idempotency-Key.
 */
export interface HttpDevOpsOptions {
  baseUrl: string;
  apiToken: string;
  signingSecret?: string;
  fetchImpl?: typeof fetch;
}

export function signDevOpsRequest(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export class HttpDevOpsProvider implements CiCdProvider {
  readonly name = 'Forgeline DevOps';
  readonly kind = 'CUSTOM_DEVOPS' as const;
  private readonly http: HttpClient;

  constructor(private readonly options: HttpDevOpsOptions) {
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      provider: 'devops',
      fetchImpl: options.fetchImpl,
      defaultHeaders: { Authorization: `Bearer ${options.apiToken}` },
    });
  }

  private signed(body: unknown, idempotencyKey?: string): { rawBody: string; headers: Record<string, string> } {
    const raw = JSON.stringify(body ?? {});
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forgeline-Timestamp': ts };
    if (this.options.signingSecret) headers['X-Forgeline-Signature'] = signDevOpsRequest(this.options.signingSecret, ts, raw);
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return { rawBody: raw, headers };
  }

  private async send<T>(method: 'POST', path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const { rawBody, headers } = this.signed(body, idempotencyKey);
    // Idempotency-Key makes POST retries safe.
    const res = await this.http.request<T>(path, { method, rawBody, headers, retry: Boolean(idempotencyKey) });
    return res.data;
  }

  async healthCheck() {
    const res = await this.http.get<{ status: string; version?: string }>('/v1/health');
    return { ok: res.status === 'ok' || res.status === 'healthy', message: res.version ? `DevOps API ${res.version}` : res.status };
  }
  startPipeline(req: PipelineRequest) {
    return this.send<PipelineRun>('POST', '/v1/pipelines', req, req.idempotencyKey);
  }
  getPipeline(id: string) {
    return this.http.get<PipelineRun>(`/v1/pipelines/${encodeURIComponent(id)}`);
  }
  async getPipelineLogs(id: string, stage?: string) {
    const res = await this.http.request<string>(`/v1/pipelines/${encodeURIComponent(id)}/logs`, { query: { stage }, responseType: 'text' });
    return res.data;
  }
  async cancelPipeline(id: string) {
    await this.send('POST', `/v1/pipelines/${encodeURIComponent(id)}/cancel`, {});
  }
  retryPipeline(id: string) {
    return this.send<PipelineRun>('POST', `/v1/pipelines/${encodeURIComponent(id)}/retry`, {});
  }
  deploy(req: DeployRequest) {
    return this.send<DeploymentHandle>('POST', '/v1/deployments', req, req.idempotencyKey);
  }
  getDeployment(id: string) {
    return this.http.get<DeploymentHandle>(`/v1/deployments/${encodeURIComponent(id)}`);
  }
  rollback(req: RollbackRequest) {
    return this.send<DeploymentHandle>('POST', `/v1/deployments/${encodeURIComponent(req.deploymentId)}/rollback`, req, req.idempotencyKey);
  }
  async listEnvironments(project: string): Promise<CiCdEnvironment[]> {
    const res = await this.http.get<{ environments: CiCdEnvironment[] }>('/v1/environments', { query: { project } });
    return res.environments;
  }
}
