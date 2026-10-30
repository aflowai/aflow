import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  createMemoryDocRepository,
  createTenantContext,
  isReservedMemoryPath,
  memoryDocs,
  withTenantSchema,
} from '@aflow/database';
import type { StagedChange, TenantId } from '@aflow/schemas';
import { PROPOSAL_DIRS } from './resolveProposalRoute.js';
import { tryParseStagedChangeDoc } from './tryParseStagedChangeDoc.js';

/** The two reads a proposal lookup needs, so a test can hold the store in memory. */
export interface StagedChangeDocReader {
  /** The document at `path` in `spaceId`, deleted or not. */
  getByPath(
    path: string,
    spaceId: string,
  ): Promise<{ inlineContent: string | null; deletedAt: Date | null } | null>;
  /** Every other space of the tenant holding a live document at `path`. */
  otherSpacesHoldingPath(path: string, spaceId: string): Promise<string[]>;
}

export function createStagedChangeDocReader(
  db: PostgresJsDatabase,
  tenantId: string,
): StagedChangeDocReader {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  return {
    async getByPath(path, spaceId) {
      const doc = await docRepo.getByPath(path, spaceId, { includeDeleted: true });
      return doc ? { inlineContent: doc.inlineContent, deletedAt: doc.deletedAt } : null;
    },
    async otherSpacesHoldingPath(path, spaceId) {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ spaceId: memoryDocs.spaceId })
          .from(memoryDocs)
          .where(
            and(
              eq(memoryDocs.path, path),
              ne(memoryDocs.spaceId, spaceId),
              isNull(memoryDocs.deletedAt),
            ),
          )
          .limit(5),
      );
      return rows.map((r) => r.spaceId);
    },
  };
}

export type StagedChangeReadFailure =
  | { reason: 'not_found'; searchedPaths: string[] }
  | { reason: 'deleted'; path: string }
  | { reason: 'refused_path'; path: string }
  | { reason: 'other_space'; path: string; foundInSpaceIds: string[] }
  | { reason: 'unparseable'; path: string; parse: 'json' | 'schema'; detail: string };

export type StagedChangeReadResult =
  { ok: true; staged: StagedChange; path: string } | ({ ok: false } & StagedChangeReadFailure);

export interface StagedChangeReadContext {
  tenantId: string;
  spaceId: string;
  proposalId: string;
  /** The surface reading, for the parse-failure log. */
  reader: string;
}

/**
 * Read one proposal and, when it cannot be returned, say why. A document that
 * fails to parse, a deleted one, a refused path and one held by another space
 * each get their own reason, so no reader reports any of them as "not found".
 */
export async function readStagedChange(
  docs: StagedChangeDocReader,
  ctx: StagedChangeReadContext,
): Promise<StagedChangeReadResult> {
  const paths = PROPOSAL_DIRS.map((dir) => `${dir}/${ctx.proposalId}.json`);
  let failure: StagedChangeReadFailure | undefined;

  for (const path of paths) {
    if (isReservedMemoryPath(path)) {
      failure ??= { reason: 'refused_path', path };
      continue;
    }
    const doc = await docs.getByPath(path, ctx.spaceId);
    if (!doc) continue;
    if (doc.deletedAt) {
      failure ??= { reason: 'deleted', path };
      continue;
    }
    if (!doc.inlineContent) {
      failure = { reason: 'unparseable', path, parse: 'json', detail: 'the document is empty' };
      continue;
    }
    const parsed = tryParseStagedChangeDoc(doc.inlineContent, {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      docPath: path,
      reader: ctx.reader,
    });
    if (parsed.ok) return { ok: true, staged: parsed.staged, path };
    failure = { reason: 'unparseable', path, parse: parsed.reason, detail: parsed.detail };
  }
  if (failure) return { ok: false, ...failure };

  for (const path of paths) {
    const foundInSpaceIds = await docs.otherSpacesHoldingPath(path, ctx.spaceId);
    if (foundInSpaceIds.length > 0) {
      return { ok: false, reason: 'other_space', path, foundInSpaceIds };
    }
  }
  return { ok: false, reason: 'not_found', searchedPaths: paths };
}

/**
 * Say why a proposal could not be read. The sentence names no id because an
 * agent's tool error strips every UUID from its message, so an id there reads
 * as a blank. The ids travel in the error's details.
 */
export function describeStagedChangeReadFailure(failure: StagedChangeReadFailure): string {
  switch (failure.reason) {
    case 'not_found':
      return (
        'No proposal with this id exists in this space. ' +
        `Neither ${PROPOSAL_DIRS.join(' nor ')} holds a document for it.`
      );
    case 'deleted':
      return 'The proposal with this id has been deleted from this space.';
    case 'refused_path':
      return 'The proposal path is reserved scratch space, and the memory store refuses to read it.';
    case 'other_space':
      return (
        'The proposal with this id is not in this space. ' +
        'Another space of this tenant holds it, so read it from that space.'
      );
    case 'unparseable':
      return (
        'The proposal document exists in this space but does not parse as a staged change ' +
        `(${failure.parse === 'json' ? 'invalid JSON' : 'schema'}). What failed: ${failure.detail}`
      );
  }
}

/** The ids and facts behind a read failure, for an error's structured details. */
export function stagedChangeReadFailureDetails(
  ctx: Pick<StagedChangeReadContext, 'spaceId' | 'proposalId'>,
  failure: StagedChangeReadFailure,
): Record<string, unknown> {
  return { proposalId: ctx.proposalId, spaceId: ctx.spaceId, ...failure };
}
