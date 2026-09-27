import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { PublicError } from './errors.js';
import { isDatabaseError, classifyDbError } from './databaseErrors.js';
import { PermissionDeniedError } from '@aflow/authz';

export function globalErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // 1. Our typed public errors — always safe to expose
  if (error instanceof PublicError) {
    request.log.warn({ err: error }, error.message);
    void reply.status(error.statusCode).send({
      error: error.errorCode,
      message: error.message,
    });
    return;
  }

  // 2. PermissionDeniedError from @aflow/authz
  if (error instanceof PermissionDeniedError) {
    request.log.warn({ err: error }, error.message);
    void reply.status(error.httpStatus).send({
      error: 'Forbidden',
      message: error.message,
    });
    return;
  }

  // 3. Fastify/Sensible 4xx errors (validation, httpErrors.*, rate limit)
  const statusCode = (error as FastifyError).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    request.log.warn({ err: error }, error.message);
    void reply.status(statusCode).send({
      error: (error as FastifyError).code ?? 'ClientError',
      message: error.message,
    });
    return;
  }

  // 4. Database errors — classify and scrub (never expose SQL)
  if (isDatabaseError(error)) {
    request.log.error({ err: error }, 'Database error (scrubbed for client)');
    const safe = classifyDbError(error, 'complete the request');
    void reply.status(safe.statusCode).send({
      error: safe.errorCode,
      message: safe.message,
      supportRef: request.id,
    });
    return;
  }

  // 5. Everything else — internal, scrub the message
  request.log.error({ err: error }, 'Unhandled server error');
  void reply.status(typeof statusCode === 'number' ? statusCode : 500).send({
    error: 'InternalError',
    message: 'An unexpected error occurred. Please try again or contact support.',
    supportRef: request.id,
  });
}
