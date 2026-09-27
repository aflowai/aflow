/**
 * Turning stored conversation metadata into what a client reads.
 *
 * The resolution rule lives here and only here: a person's name outranks a
 * generated one, always and everywhere. Storing the two separately is what
 * makes that safe — a generation landing seconds after a rename writes a
 * column this function then declines to read, so the two writers never race.
 */
import type { SessionMetadata, SessionMetadataDetail } from '@aflow/schemas';
import type { StoredSessionMetadata } from '@aflow/database';

export function projectSessionMetadata(stored: {
  title: StoredSessionMetadata['title'];
  titleState: StoredSessionMetadata['titleState'];
  manualTitle: StoredSessionMetadata['manualTitle'];
  summary: StoredSessionMetadata['summary'];
  summaryCoverage: StoredSessionMetadata['summaryCoverage'];
  metadataRevision: StoredSessionMetadata['metadataRevision'];
  metadataEvidenceRevision: StoredSessionMetadata['metadataEvidenceRevision'];
  metadataUpdatedAt: StoredSessionMetadata['metadataUpdatedAt'];
  metadataEditedBy: StoredSessionMetadata['metadataEditedBy'];
}): SessionMetadata {
  const manual = stored.manualTitle;
  return {
    title: manual ?? stored.title,
    titleSource: manual ? 'manual' : stored.title ? 'generated' : null,
    // A person's name has no automatic state — nothing will refine it, and
    // reporting the generated one's state here would suggest otherwise.
    titleState: manual ? null : stored.titleState,
    summary: stored.summary,
    summaryCoverage: stored.summaryCoverage,
    revision: stored.metadataRevision,
    updatedAt: stored.metadataUpdatedAt ? stored.metadataUpdatedAt.toISOString() : null,
    editedByUserId: stored.metadataEditedBy,
    // Nothing generated yet, and something to generate from. Diagnostics for
    // an inspector; deliberately not a status the conversation wears.
    pending: stored.title === null && stored.summary === null,
  };
}

export function projectSessionMetadataDetail(stored: StoredSessionMetadata): SessionMetadataDetail {
  return {
    ...projectSessionMetadata(stored),
    provenance: stored.record.provenance ?? null,
    diagnostic: stored.record.diagnostic ?? null,
  };
}

/**
 * What a session that exists but has not been projected yet looks like.
 *
 * Postgres trails Redis, so a conversation opened seconds ago has no durable
 * row. That is lateness, not absence — the caller has already established that
 * the session exists and that they may read it — and answering 404 sends a
 * client hunting for a conversation it is looking straight at.
 */
export const UNPROJECTED_SESSION_METADATA: SessionMetadataDetail = {
  title: null,
  titleSource: null,
  titleState: null,
  summary: null,
  summaryCoverage: null,
  revision: 0,
  updatedAt: null,
  editedByUserId: null,
  pending: true,
  provenance: null,
  diagnostic: null,
};
