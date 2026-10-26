import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { StoreInstall } from '@aflow/schemas';
import { CODING_LOOP_PART_IDS } from '@aflow/platform-artifacts';
import { getStoreInstall } from './storeInstallProvenance.js';

export function codingLoopInstallFromParts(installs: readonly StoreInstall[]): StoreInstall | null {
  const existing = installs.find((install) => install.catalogId === 'coding-loop');
  if (existing) return existing;
  const parts = installs.filter((install) =>
    CODING_LOOP_PART_IDS.some((id) => id === install.catalogId),
  );
  const first = parts[0];
  if (!first) return null;
  return {
    ...first,
    catalogId: 'coding-loop',
    installedVersion: parts.reduce((sum, part) => sum + part.installedVersion, 0),
  };
}

export async function readCodingLoopParts(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<StoreInstall | null> {
  const parts: StoreInstall[] = [];
  for (const id of CODING_LOOP_PART_IDS) {
    const part = await getStoreInstall(tx, spaceId, id);
    if (part) parts.push(part);
  }
  return codingLoopInstallFromParts(parts);
}
