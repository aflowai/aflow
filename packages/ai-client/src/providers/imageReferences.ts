/**
 * Reference images are refused by any route that cannot condition on them.
 *
 * Dropping them returns a plausible image carrying none of the requested
 * consistency, and nothing downstream can tell the difference — the failure
 * only surfaces once the shots are cut together.
 */
import { AIClientError } from '../errors.js';
import type { AIProvider, GenerateImageRequest } from '../types.js';

export function refuseImageReferences(
  request: Pick<GenerateImageRequest, 'model' | 'references'>,
  provider: AIProvider,
  because: string,
): void {
  if (request.references === undefined || request.references.length === 0) return;
  throw new AIClientError(
    `Model "${request.model}" does not accept reference images: ${because}`,
    'invalid_request',
    provider,
    false,
  );
}
