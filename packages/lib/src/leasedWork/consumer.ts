/**
 * The item protocol every candidate-driven consumer shares: claim a leased
 * batch, work each item, and end it in exactly one of the protocol's ways —
 * acknowledged, retired behind a durable disposition, left leased for
 * redelivery, or discarded because it cannot name itself.
 *
 * `createBackgroundTaskRunner` owns the cycle; this owns the items inside one.
 * The sequencing lives here because every hand-rolled copy has gotten one edge
 * wrong: an ack that proved the wrong thing, a disposition that was not
 * terminal, a retirement that destroyed the only copy, a worker acting on a
 * claim it had already lost. A call site supplies the substrate primitives and
 * the work; it cannot reorder the protocol around them.
 *
 * What the runner requires of its callbacks, because no code here can see the
 * substrate:
 *
 * - `claim` leases and never deletes. A crash anywhere below costs a
 *   redelivery at lease expiry, never the item.
 * - `ack` and `retire` are compare-and-ack primitives proving ownership (the
 *   claim is still this worker's) and currency (the item did not change while
 *   it worked). The whole claim object is handed back, so its tokens travel
 *   with it. A refusal means a successor or a newer arming owns the item now:
 *   the runner touches nothing further.
 * - a disposition is idempotent, keyed by stable item identity — a crash
 *   between it and the retirement redelivers into the existing record — and
 *   it consumes the item's attempt/generation, so budgets converge instead of
 *   cycling.
 * - `discard` is the only unguarded removal, and the runner reaches it solely
 *   for items `validate` rejects: a payload that cannot name itself has no
 *   identity for a guard or a disposition to key on.
 */

/** What one worked item asks the runner to do with it. */
export type LeasedWorkResult =
  /** The work landed durably; acknowledge the claim. */
  | { kind: 'completed' }
  /**
   * Leave the item leased and untouched, spending nothing: the failure was
   * not the item's own (another domain's write riding this boundary), or the
   * item is simply not actionable this pass.
   */
  | { kind: 'yield'; reason: string }
  /**
   * The item can never be worked. `disposition` commits the durable,
   * idempotent record of that fact and answers whether retirement is
   * authorized — false when the record could not be written, which leaves the
   * item leased rather than silently gone.
   */
  | { kind: 'unworkable'; disposition: () => Promise<boolean> }
  /**
   * The work failed in a way that may go better next time. `budget` counts
   * the failure against the item's durable redelivery budget and answers
   * whether the item is now given up on; anything short of eviction leaves it
   * leased for redelivery.
   */
  | { kind: 'failed'; budget: () => Promise<{ evict: boolean }> }
  /**
   * The work failed AND the item is still acknowledged. For substrates whose
   * ack re-scores a pointer rather than deleting the work — the failed rows
   * stay where they are, and the cadence is the retry pace, not the lease.
   */
  | { kind: 'failed_settled' };

/** Protocol edges a call site may want to log; the runner only counts them. */
export type LeasedWorkEvent<C> =
  | { kind: 'discarded'; claim: C; reason: string }
  | { kind: 'discard_error'; claim: C; error: unknown }
  | { kind: 'work_error'; claim: C; error: unknown }
  | { kind: 'ack_refused'; claim: C }
  | { kind: 'ack_error'; claim: C; error: unknown }
  | { kind: 'retire_refused'; claim: C }
  | { kind: 'retire_error'; claim: C; error: unknown }
  | { kind: 'disposition_failed'; claim: C; error: unknown }
  | { kind: 'budget_error'; claim: C; error: unknown }
  | { kind: 'after_completed_error'; claim: C; error: unknown }
  | { kind: 'release_error'; claim: C; error: unknown };

export interface LeasedWorkConsumerConfig<C> {
  /** Names the consumer in nothing but the caller's own logging. */
  name: string;
  /** Lease up to `limit` items. Leases; never deletes. Optional for lanes fed
   *  through `runClaimed`, whose outer claim already leased them. */
  claim?(limit: number): Promise<C[]>;
  /**
   * Refuse an item whose payload cannot name it. Rejected items are the one
   * lane that bypasses every guard: they go to `discard`, because there is no
   * identity to prove ownership of and no record a disposition could key.
   */
  validate?(claim: C): { ok: true } | { ok: false; reason: string };
  /** Unguarded removal, reachable only through a `validate` rejection. */
  discard?(claim: C): Promise<void>;
  /**
   * Work one item. Errors belong to the call site — classify and return the
   * matching result. A throw that escapes anyway leaves the item leased for
   * redelivery, which is the safe reading of "the classifier itself is what
   * broke".
   */
  work(claim: C): Promise<LeasedWorkResult>;
  /** Compare-and-ack. False: the item changed or changed hands; it stays due. */
  ack(claim: C): Promise<boolean>;
  /**
   * Guarded retirement behind an authorized disposition. False: the item
   * moved; it stays. Optional only for lanes whose work never answers
   * `unworkable` or evicts — reaching retirement without one leaves the item
   * leased and surfaces `retire_error`.
   */
  retire?(claim: C): Promise<boolean>;
  /**
   * Hand an unworked claim back so its lease returns now rather than
   * expiring. Reached only when a batch stops early (`shouldContinue`).
   */
  release?(claim: C): Promise<void>;
  /**
   * Runs after completed work whatever the acknowledgement answered — the
   * work's durable effect exists even when the claim was lost, so anything
   * here must be safe under a lost claim.
   */
  afterCompleted?(claim: C): Promise<void>;
  onEvent?(event: LeasedWorkEvent<C>): void;
}

export interface LeasedWorkBatchStats {
  claimed: number;
  /** Validate-rejected items removed unguarded. */
  discarded: number;
  /** Discards that failed; the item stays armed and is claimed again. */
  discardErrors: number;
  completed: number;
  ackRefused: number;
  ackErrors: number;
  yielded: number;
  /** Items retired behind an authorized disposition. */
  retired: number;
  /** Guarded retirements refused — the item moved and stays. */
  retireRefused: number;
  /** Dispositions that failed or were not authorized; the item stays leased. */
  dispositionsFailed: number;
  /** Failures counted against a budget without reaching eviction. */
  failures: number;
  /** Failures whose budget answered eviction. */
  evicted: number;
  /** Throws that escaped `work`; the item stays leased. */
  workErrors: number;
  /** Failures acknowledged anyway (`failed_settled`). */
  failedSettled: number;
  /** Budgets that themselves failed; the item stays leased. */
  budgetErrors: number;
  /** Unworked claims handed back when the batch stopped early. */
  released: number;
}

/**
 * The consumer over items an outer claim already leased. For substrates whose
 * one claim call answers with several lanes at once — each lane gets its own
 * consumer, and the protocol still owns every item.
 */
export interface RunClaimedOptions {
  /**
   * Checked before each item. Answering false releases the remainder
   * unworked — the batch-abort a cycle budget or a shutdown signal needs.
   */
  shouldContinue?: () => boolean;
}

export interface PreclaimedLeasedWorkConsumer<C> {
  runClaimed(claims: readonly C[], options?: RunClaimedOptions): Promise<LeasedWorkBatchStats>;
}

export interface LeasedWorkConsumer<C> extends PreclaimedLeasedWorkConsumer<C> {
  /** Claim and process one batch. Item processing is sequential. */
  runBatch(limit: number): Promise<LeasedWorkBatchStats>;
}

function emptyBatchStats(): LeasedWorkBatchStats {
  return {
    claimed: 0,
    discarded: 0,
    discardErrors: 0,
    completed: 0,
    ackRefused: 0,
    ackErrors: 0,
    yielded: 0,
    retired: 0,
    retireRefused: 0,
    dispositionsFailed: 0,
    failures: 0,
    evicted: 0,
    workErrors: 0,
    failedSettled: 0,
    budgetErrors: 0,
    released: 0,
  };
}

export function createLeasedWorkConsumer<C>(
  config: LeasedWorkConsumerConfig<C> & { claim: (limit: number) => Promise<C[]> },
): LeasedWorkConsumer<C>;
// A consumer built without `claim` has no `runBatch` to call — the wiring
// mistake is uncompilable rather than a cycle-time throw.
export function createLeasedWorkConsumer<C>(
  config: LeasedWorkConsumerConfig<C>,
): PreclaimedLeasedWorkConsumer<C>;
export function createLeasedWorkConsumer<C>(
  config: LeasedWorkConsumerConfig<C>,
): LeasedWorkConsumer<C> {
  const emit = (event: LeasedWorkEvent<C>): void => {
    // Fenced like every other callback: an observer is the one place a throw
    // would otherwise escape the protocol it only watches.
    try {
      config.onEvent?.(event);
    } catch {
      /* an observer must not disturb the batch */
    }
  };

  async function guardedRetire(claim: C, stats: LeasedWorkBatchStats): Promise<void> {
    if (!config.retire) {
      stats.retireRefused++;
      emit({
        kind: 'retire_error',
        claim,
        error: new Error(`leased-work consumer "${config.name}" reached retirement with no retire`),
      });
      return;
    }
    try {
      if (await config.retire(claim)) {
        stats.retired++;
      } else {
        stats.retireRefused++;
        emit({ kind: 'retire_refused', claim });
      }
    } catch (error) {
      // The disposition is durable and the lease is still held, so redelivery
      // finds the record and retries only the retirement.
      stats.retireRefused++;
      emit({ kind: 'retire_error', claim, error });
    }
  }

  async function processItem(claim: C, stats: LeasedWorkBatchStats): Promise<void> {
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = config.validate?.(claim) ?? { ok: true };
    } catch (error) {
      // A throwing validator is a broken classifier, and the item must not
      // reach the unguarded discard on the strength of a possibly transient
      // bug — leased redelivery keeps the only copy.
      stats.workErrors++;
      emit({ kind: 'work_error', claim, error });
      return;
    }
    if (!verdict.ok) {
      if (!config.discard) {
        // Reporting a removal that did not happen is worse than the noise:
        // the item stays leased and comes back, and the count has to say so.
        stats.discardErrors++;
        emit({
          kind: 'discard_error',
          claim,
          error: new Error(
            `leased-work consumer "${config.name}" rejected an item with no discard`,
          ),
        });
        return;
      }
      try {
        await config.discard(claim);
      } catch (error) {
        stats.discardErrors++;
        emit({ kind: 'discard_error', claim, error });
        return;
      }
      stats.discarded++;
      emit({ kind: 'discarded', claim, reason: verdict.reason });
      return;
    }

    let result: LeasedWorkResult;
    try {
      result = await config.work(claim);
    } catch (error) {
      stats.workErrors++;
      emit({ kind: 'work_error', claim, error });
      return;
    }

    switch (result.kind) {
      case 'completed': {
        stats.completed++;
        try {
          if (!(await config.ack(claim))) {
            stats.ackRefused++;
            emit({ kind: 'ack_refused', claim });
          }
        } catch (error) {
          stats.ackErrors++;
          emit({ kind: 'ack_error', claim, error });
        }
        if (config.afterCompleted) {
          try {
            await config.afterCompleted(claim);
          } catch (error) {
            emit({ kind: 'after_completed_error', claim, error });
          }
        }
        return;
      }
      case 'yield': {
        stats.yielded++;
        return;
      }
      case 'failed_settled': {
        stats.failedSettled++;
        try {
          if (!(await config.ack(claim))) {
            stats.ackRefused++;
            emit({ kind: 'ack_refused', claim });
          }
        } catch (error) {
          stats.ackErrors++;
          emit({ kind: 'ack_error', claim, error });
        }
        return;
      }
      case 'unworkable': {
        let authorized = false;
        try {
          authorized = await result.disposition();
        } catch (error) {
          stats.dispositionsFailed++;
          emit({ kind: 'disposition_failed', claim, error });
          return;
        }
        if (!authorized) {
          stats.dispositionsFailed++;
          return;
        }
        await guardedRetire(claim, stats);
        return;
      }
      case 'failed': {
        let evict = false;
        try {
          ({ evict } = await result.budget());
        } catch (error) {
          stats.budgetErrors++;
          emit({ kind: 'budget_error', claim, error });
          return;
        }
        if (!evict) {
          stats.failures++;
          return;
        }
        stats.evicted++;
        await guardedRetire(claim, stats);
        return;
      }
    }
  }

  async function runClaimed(
    claims: readonly C[],
    options?: RunClaimedOptions,
  ): Promise<LeasedWorkBatchStats> {
    const stats = emptyBatchStats();
    stats.claimed = claims.length;
    for (const claim of claims) {
      if (options?.shouldContinue && !options.shouldContinue()) {
        stats.released++;
        try {
          await config.release?.(claim);
        } catch (error) {
          emit({ kind: 'release_error', claim, error });
        }
        continue;
      }
      await processItem(claim, stats);
    }
    return stats;
  }

  return {
    async runBatch(limit: number): Promise<LeasedWorkBatchStats> {
      if (!config.claim) {
        throw new Error(`leased-work consumer "${config.name}" has no claim; use runClaimed`);
      }
      return runClaimed(await config.claim(limit));
    },
    runClaimed,
  };
}
