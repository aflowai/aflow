import type { ErrorClassification } from '@aflow/schemas';

export function looksLikeSqlError(raw: string): boolean {
  return raw.includes('Failed query:') || raw.includes('PostgresError') || raw.includes('column "');
}

/**
 * Map thrown Error.message from eval/guardrail-style handlers to a classification.
 */
export function classifyInlineCrudCatch(
  message: string,
  unknownOperationPrefix: string,
): ErrorClassification {
  if (looksLikeSqlError(message)) return 'internal';
  if (message.startsWith(unknownOperationPrefix)) return 'validation';
  if (message.includes('No transcript available')) return 'not_found';
  if (message.includes(' not found')) return 'not_found';
  return 'internal';
}
