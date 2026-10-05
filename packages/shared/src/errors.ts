/**
 * Classification of failures from tools/integrations. The workflow engine uses
 * `retryable` to decide between retry (transient) and repair/fail (permanent).
 */
export const TOOL_ERROR_KINDS = [
  'timeout',
  'auth',
  'rate_limit',
  'validation',
  'external',
  'network',
  'malformed_response',
  'permission',
  'not_found',
  'conflict',
  'not_configured',
  'assertion',
  'cancelled',
  'internal',
] as const;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<ToolErrorKind> = new Set(['timeout', 'rate_limit', 'external', 'network', 'malformed_response']);

export interface SerializedToolError {
  kind: ToolErrorKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
  provider?: string;
  details?: Record<string, unknown>;
}

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly provider?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ToolErrorKind,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      status?: number;
      provider?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ToolError';
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(kind);
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.provider = options.provider;
    this.details = options.details;
  }

  toJSON(): SerializedToolError {
    return {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }),
      ...(this.status !== undefined && { status: this.status }),
      ...(this.provider !== undefined && { provider: this.provider }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }

  static is(err: unknown): err is ToolError {
    return (
      err instanceof ToolError ||
      (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ToolError' && 'kind' in err)
    );
  }

  /** Normalise any thrown value into a ToolError. */
  static from(err: unknown, provider?: string): ToolError {
    if (ToolError.is(err)) return err;
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return new ToolError('timeout', err.message || 'Operation timed out', { provider, cause: err });
      }
      const code = (err as { code?: string }).code ?? (err.cause as { code?: string } | undefined)?.code;
      if (
        code &&
        ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
      ) {
        return new ToolError('network', `${err.message} (${code})`, { provider, cause: err });
      }
      if (err.message === 'fetch failed') {
        return new ToolError('network', 'Network request failed', { provider, cause: err });
      }
      return new ToolError('internal', err.message, { provider, cause: err, retryable: false });
    }
    return new ToolError('internal', String(err), { provider, retryable: false });
  }
}
