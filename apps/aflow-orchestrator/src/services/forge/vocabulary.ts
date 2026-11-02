/**
 * The forge vocabulary as the pull request event source speaks it (Plan 340
 * D1): one conditional read of a forge's API, what one poll of a change
 * request reads, and the reader a provider answers it through. The source
 * compares snapshots and emits changes. Each provider owns the paths it polls
 * and the shapes it parses.
 */
import type { PullRequestChecksState, PullRequestReadState, PullRequestWatch } from '@aflow/redis';

export interface ConditionalAnswer {
  status: number;
  etag: string | null;
  body: unknown;
}

/** One conditional GET of a path under a forge's API, for a space. */
export type ForgeConditionalGet = (args: {
  tenantId: string;
  spaceId: string;
  /** Starts with `/`, e.g. `/repos/o/r/pulls/1`. */
  path: string;
  etag?: string;
  signal?: AbortSignal;
}) => Promise<ConditionalAnswer>;

/** What one poll of a change request reads. */
export interface PullRequestSnapshot {
  pull: PullRequestReadState;
  /** Undefined once the change request is closed: nothing reads its checks then. */
  checks?: PullRequestChecksState;
  changesRequested?: boolean;
}

/** A provider's reads of one change request, for the event source. */
export interface ForgeEventReader {
  /** Poll one change request: its state, and while it is open its head's checks and its reviews. */
  poll(
    get: ForgeConditionalGet,
    watch: PullRequestWatch,
    signal?: AbortSignal,
  ): Promise<{ watch: PullRequestWatch; snapshot: PullRequestSnapshot }>;
  /** The snapshot the reads a watch saved make, or undefined before its first poll. */
  snapshotOf(watch: PullRequestWatch): PullRequestSnapshot | undefined;
  /** Whether the forge's word for a change request's mergeability says its head conflicts with its base. */
  conflicting(pull: PullRequestReadState): boolean;
}
