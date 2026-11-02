/**
 * The event source's providers, named from a repository's host (Plan 340 D1).
 * The source asks here for the reader of a watched change request and never
 * names a provider itself.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type ForgeProviderId, requireForgeProvider } from '@aflow/schemas';
import { createGitHubConditionalGet } from './github/conditionalGet.js';
import { GITHUB_EVENT_READER } from './github/pullRequestReads.js';
import type { ForgeConditionalGet, ForgeEventReader } from './vocabulary.js';

const EVENT_READERS: Readonly<Record<ForgeProviderId, ForgeEventReader>> = {
  github: GITHUB_EVENT_READER,
};

/**
 * The reader of the change request at `url`, by the provider its host names.
 * With no address, the repo coordinate's default host names it.
 */
export function forgeEventReaderFor(url?: string): ForgeEventReader {
  return EVENT_READERS[requireForgeProvider(url === undefined ? undefined : new URL(url).host)];
}

/** The production reader of the forge the event source polls, built from the database. */
export function createForgeConditionalGet(deps: { db: PostgresJsDatabase }): ForgeConditionalGet {
  return createGitHubConditionalGet(deps);
}
