/**
 * A committed history batch the store could not read. `committedAtTurn` is the
 * earliest turn of any atom naming the ref — with the read error, it is what
 * tells a payload that aged out from one that is corrupt.
 */
export interface UnreadableHistoryBatch {
  ref: string;
  committedAtTurn: number | null;
  readError: string;
}

export interface HistoryIntegrityIssue {
  atomId: string;
  ref: string;
  reason: string;
}

export function unreadableHistoryBatch(ref: string, cause: unknown): UnreadableHistoryBatch {
  return {
    ref,
    committedAtTurn: null,
    readError: cause instanceof Error ? cause.message : String(cause),
  };
}

export function noteCommittedTurn(
  batch: UnreadableHistoryBatch,
  turnNumber: number | undefined,
): void {
  if (turnNumber === undefined) return;
  if (batch.committedAtTurn === null || turnNumber < batch.committedAtTurn) {
    batch.committedAtTurn = turnNumber;
  }
}

function describeFailure(
  atTurn: number,
  failedBatches: readonly UnreadableHistoryBatch[],
  issueCount: number,
): string {
  const named = failedBatches
    .map((b) => {
      const turn = b.committedAtTurn === null ? 'unknown' : String(b.committedAtTurn);
      return `${b.ref} (committed at turn ${turn}: ${b.readError})`;
    })
    .join('; ');
  return (
    `Committed conversation history could not be hydrated at turn ${String(atTurn)} ` +
    `(${String(failedBatches.length)} unreadable batch(es), ${String(issueCount)} atom issue(s)).` +
    (named ? ` Unreadable: ${named}.` : '')
  );
}

/** Thrown when committed history atoms cannot be hydrated — fail closed (retryable). */
export class ConversationHistoryHydrationError extends Error {
  readonly code = 'CONVERSATION_HISTORY_HYDRATION_FAILED';

  constructor(
    atTurn: number,
    public readonly failedBatches: UnreadableHistoryBatch[],
    public readonly integrityIssues: HistoryIntegrityIssue[],
  ) {
    super(describeFailure(atTurn, failedBatches, integrityIssues.length));
    this.name = 'ConversationHistoryHydrationError';
  }
}
