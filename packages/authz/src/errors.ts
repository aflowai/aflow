export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED' as const;
  readonly httpStatus = 403;
  readonly resource: string;
  readonly action: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(resource: string, action: string, details?: Record<string, unknown>) {
    super(`You do not have permission to ${action} this ${resource}.`);
    this.name = 'PermissionDeniedError';
    this.resource = resource;
    this.action = action;
    this.details = details ?? undefined;
  }
}
