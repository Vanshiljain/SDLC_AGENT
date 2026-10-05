import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HEADER_REQUEST_ID } from '@forgeline/shared';
import { RequestContext } from './request-context';

const SAFE_ID = /^[A-Za-z0-9._-]{8,100}$/;

/** Assigns/propagates X-Request-Id and opens the correlation context for the request. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[HEADER_REQUEST_ID];
    const requestId = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    (req as Request & { id?: string }).id = requestId;
    res.setHeader('X-Request-Id', requestId);
    RequestContext.run({ requestId, ip: req.ip, userAgent: req.headers['user-agent'] }, () => next());
  }
}
