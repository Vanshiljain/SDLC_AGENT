import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@forgeline/database';
import { ToolError, type ApiErrorBody, type ToolErrorKind } from '@forgeline/shared';
import { WorkflowValidationError } from '@forgeline/workflow-engine';
import { RequestContext } from './context/request-context';
import { redact } from './redaction';

/** Domain exception with a stable machine-readable code. */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ statusCode: status, error: HttpStatus[status] ?? 'Error', message, code, details }, status);
  }

  static notFound(what: string, id?: string) {
    return new AppException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what}${id ? ` ${id}` : ''} not found`);
  }
  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new AppException(HttpStatus.FORBIDDEN, code, message);
  }
  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message, details);
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new AppException(HttpStatus.CONFLICT, code, message);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }
  static precondition(message: string, code = 'PRECONDITION_FAILED') {
    return new AppException(HttpStatus.PRECONDITION_FAILED, code, message);
  }
}

/** Error-tracking abstraction (Sentry/Datadog adapters implement this). */
export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
}
export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

@Injectable()
export class LoggingErrorReporter implements ErrorReporter {
  private readonly logger = new Logger('ErrorReporter');
  captureException(error: unknown, context?: Record<string, unknown>): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.logger.error(
      { err: { message: err.message, stack: err.stack, name: err.name }, ...redact(context ?? {}), ...RequestContext.get() },
      err.message,
    );
  }
}

const TOOL_ERROR_STATUS: Record<ToolErrorKind, number> = {
  validation: 400,
  auth: 502,
  permission: 403,
  not_found: 404,
  conflict: 409,
  rate_limit: 429,
  timeout: 504,
  network: 502,
  external: 502,
  malformed_response: 502,
  not_configured: 412,
  assertion: 422,
  cancelled: 409,
  internal: 500,
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = RequestContext.get().requestId ?? (req.headers['x-request-id'] as string | undefined);
    let body: ApiErrorBody;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const p = typeof payload === 'string' ? { message: payload } : (payload as Record<string, unknown>);
      const message = Array.isArray(p.message) ? p.message.join('; ') : String(p.message ?? exception.message);
      body = {
        statusCode: status,
        error: String(p.error ?? HttpStatus[status] ?? 'Error'),
        message,
        code: (p.code as string | undefined) ?? (status === 400 && Array.isArray(p.message) ? 'VALIDATION_FAILED' : HttpStatus[status]),
        details: p.details ?? (Array.isArray(p.message) ? p.message : undefined),
      };
      if (status >= 500) this.reporter.captureException(exception, { path: req.path });
    } else if (ToolError.is(exception)) {
      const status = TOOL_ERROR_STATUS[exception.kind] ?? 500;
      body = {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        message: exception.message,
        code: `TOOL_${exception.kind.toUpperCase()}`,
      };
      if (status >= 500) this.reporter.captureException(exception, { path: req.path });
    } else if (exception instanceof WorkflowValidationError) {
      body = { statusCode: 400, error: 'Bad Request', message: exception.message, code: 'INVALID_WORKFLOW', details: exception.issues };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      body = {
        statusCode: 409,
        error: 'Conflict',
        message: 'A resource with these unique values already exists',
        code: 'UNIQUE_VIOLATION',
        details: exception.meta?.target,
      };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      body = { statusCode: 404, error: 'Not Found', message: 'Resource not found', code: 'NOT_FOUND' };
    } else {
      this.reporter.captureException(exception, { path: req.path, method: req.method });
      body = { statusCode: 500, error: 'Internal Server Error', message: 'An unexpected error occurred', code: 'INTERNAL' };
    }
    body.requestId = requestId;
    res.status(body.statusCode).json(body);
  }
}
