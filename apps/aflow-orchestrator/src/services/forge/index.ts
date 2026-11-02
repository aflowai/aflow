/**
 * The event source's providers, named from a repository's host (Plan 340 D1).
 * The source asks here for the provider of a watched change request and never
 * names a provider itself. One selection gives both the reader that parses
 * the forge's answers and the conditional GET that carries them.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type ForgeProviderId, requireForgeProvider } from '@aflow/schemas';
import { createGitHubConditionalGet } from './github/conditionalGet.js';
import { GITHUB_EVENT_READER } from './github/pullRequestReads.js';
import type { ForgeConditionalGet, ForgeEventReader } from './vocabulary.js';

/** Each provider's conditional GET, each bound to its own forge's API. */
export type ForgeConditionalGets = Readonly<Record<ForgeProviderId, ForgeConditionalGet>>;

/** What the event source polls one change request through: its provider's reader and transport. */
export interface ForgeEventProvider {
  reader: ForgeEventReader;
  get: ForgeConditionalGet;
}

const EVENT_READERS: Readonly<Record<ForgeProviderId, ForgeEventReader>> = {
  github: GITHUB_EVENT_READER,
};

function providerOf(url: string | undefined): ForgeProviderId {
  return requireForgeProvider(url === undefined ? undefined : new URL(url).host);
}

/**
 * The reader and the conditional GET of the change request at `url`, both of
 * the provider its host names. With no address, the repo coordinate's default
 * host names it. A host no provider answers for throws.
 */
export function forgeEventProviderFor(
  gets: ForgeConditionalGets,
  url?: string,
): ForgeEventProvider {
  const provider = providerOf(url);
  return { reader: EVENT_READERS[provider], get: gets[provider] };
}

/** The reader of the change request at `url`, by the provider its host names. */
export function forgeEventReaderFor(url?: string): ForgeEventReader {
  return EVENT_READERS[providerOf(url)];
}

/** The production conditional GET of each forge the event source polls, built from the database. */
export function createForgeConditionalGets(deps: { db: PostgresJsDatabase }): ForgeConditionalGets {
  return { github: createGitHubConditionalGet(deps) };
}
