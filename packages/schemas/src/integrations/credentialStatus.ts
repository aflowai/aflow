import { z } from 'zod';

/**
 * Credential readiness of an integration binding. Leaf module — importable
 * from operation schemas without pulling the connector catalog (a
 * cross-directory import of `integrations/index.js` creates an ESM dist
 * chunk cycle that leaves model schemas undefined at eval).
 */
export const IntegrationCredentialStatusSchema = z.enum([
  'ready',
  'missing',
  'unpinned',
  'expired',
]);
export type IntegrationCredentialStatus = z.infer<typeof IntegrationCredentialStatusSchema>;
