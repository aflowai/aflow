import crypto from 'crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { platformAuditLog } from '@aflow/database';
import { redactAuditDetails } from '../lib/auditRedaction.js';

// ============================================================================
// Types
// ============================================================================

export interface AuditEventInput {
  /** Actor context (from request) */
  actor: {
    userId: string;
    kind: string;
    authMethod: string;
    tenantId: string;
    tenantRole?: string;
    displayName?: string;
    email?: string;
  };
  /** Event category */
  category: 'auth' | 'authz' | 'resource' | 'admin' | 'security';
  /** Specific action */
  action: string;
  /** Outcome */
  outcome: 'success' | 'failure' | 'denied';
  /** Target resource */
  target?: {
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
    spaceId?: string;
  };
  /** Additional details */
  details?: Record<string, unknown>;
  /** Error info */
  error?: {
    code: string;
    message: string;
  };
  /** HTTP request metadata */
  request?: {
    method: string;
    path: string;
    ipAddress?: string;
    userAgent?: string;
  };
}

interface BufferedAuditEvent extends AuditEventInput {
  id: string;
  timestamp: Date;
  /** Writes attempted for this event, so one bad row cannot block the queue. */
  attempts: number;
}

/**
 * Attempts before an event is treated as unwritable rather than unlucky.
 *
 * A row that fails on its own content fails identically forever, so retrying it
 * without a ceiling stalls every event behind it — the failure mode is not the
 * loss of one record but the silent loss of all subsequent ones.
 */
const MAX_EVENT_ATTEMPTS = 5;

/**
 * Hard ceiling on retained events.
 *
 * Unbounded retention turns a database outage into an out-of-memory kill, which
 * loses the buffer anyway and takes the API with it. What matters is that
 * reaching the ceiling is counted and said out loud rather than absorbed.
 */
const MAX_RETAINED_EVENTS = 10_000;

/**
 * Whether a write failed because of the row or because of the connection.
 *
 * The attempt budget exists for a row that fails on its own content, which
 * fails identically forever. A connection reset is not that: every event in
 * flight sees it, so charging each of them an attempt spends the whole budget
 * inside one outage — at a one-second cadence, five seconds of unreachable
 * database drops everything buffered. The budget must only be spent on errors
 * that will still be there when the database comes back.
 *
 * Classed by SQLSTATE: 22 is a data exception, 23 an integrity violation — both
 * properties of the row. Everything else, including anything with no code at
 * all, is treated as transient, because the cost of being wrong in that
 * direction is a retry and in the other direction is lost evidence.
 */
function isDeterministicWriteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return code.startsWith('22') || code.startsWith('23');
}

// ============================================================================
// Audit Service Implementation
// ============================================================================

class AuditServiceImpl {
  private buffer: BufferedAuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private flushing = false;
  private dropped = 0;
  /** Non-zero while writes are failing, which is what spaces the retries. */
  private consecutiveFlushFailures = 0;

  constructor(
    private readonly getDb: () => PostgresJsDatabase | null,
    private readonly log: FastifyInstance['log'],
    options?: { maxBufferSize?: number; flushIntervalMs?: number },
  ) {
    this.maxBufferSize = options?.maxBufferSize ?? 100;
    this.flushIntervalMs = options?.flushIntervalMs ?? 1000;
  }

  /** Start the periodic flush timer */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Stop the timer and drain what is buffered.
   *
   * One flush is not a drain once a failure can requeue: the events it puts
   * back have nothing left to retry them, so a single attempt at shutdown
   * turns the retry into a guarantee of loss at the one moment the process is
   * about to stop existing. Drains until the queue empties or attempts stop
   * making progress, then reports whatever it could not place.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    for (let pass = 0; pass < MAX_EVENT_ATTEMPTS && this.buffer.length > 0; pass += 1) {
      const before = this.buffer.length;
      await this.flush();
      // No progress means the dependency is gone rather than slow; further
      // passes would spin without writing anything.
      if (this.buffer.length >= before) break;
    }

    if (this.buffer.length > 0) {
      this.log.error(
        { pending: this.buffer.length, droppedTotal: this.dropped },
        '[audit] shutting down with events still unwritten — this many records are lost',
      );
    }
  }

  /** Events that could not be written, ever, since this process started. */
  get droppedEventCount(): number {
    return this.dropped;
  }

  /** Record an audit event (fire-and-forget, never blocks) */
  record(event: AuditEventInput): void {
    // Redacted on the way in, not on the way out: an audit row is retained on
    // purpose, and `details` carries whatever its caller passed.
    const details = redactAuditDetails(event.details);
    const buffered: BufferedAuditEvent = {
      ...event,
      ...(details !== undefined ? { details } : {}),
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 0,
    };
    // The ceiling belongs on intake too. Enforcing it only where events are
    // returned leaves the case it was written for wide open: while the database
    // is unreachable, nothing requeues and every incoming event simply appends,
    // so the buffer grows until the process dies — which is the outcome the
    // ceiling exists to convert into a counted, survivable loss.
    if (this.buffer.length >= MAX_RETAINED_EVENTS) {
      this.dropped += 1;
      this.log.error(
        { droppedTotal: this.dropped, retained: MAX_RETAINED_EVENTS, action: event.action },
        '[audit] retention ceiling reached on intake — audit evidence is being lost',
      );
      return;
    }

    this.buffer.push(buffered);

    // A security event is the one an incident is reconstructed from, and the
    // gap between recording and writing is exactly the window in which the
    // thing being audited can take the process down. Waiting out the interval
    // timer for it optimizes the wrong side of that trade.
    //
    // Suppressed while a flush is failing, though: an immediate flush per event
    // spends the whole attempt budget inside one outage, at machine speed, and
    // a record retried five times in as many milliseconds has not been retried
    // at all. The interval timer is the spacing.
    const urgent = event.category === 'security' && this.consecutiveFlushFailures === 0;
    if (urgent || this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  /**
   * Return events to the queue after a failed write, and account for anything
   * the ceiling forces out.
   *
   * Failed events go to the FRONT: they are the oldest, and the earliest
   * evidence is what an investigation starts from. Overflow is therefore taken
   * from the newest, and counted — the previous behaviour discarded the batch
   * with a log line nobody reads, which is indistinguishable from having
   * recorded nothing at all.
   */
  private requeue(failed: BufferedAuditEvent[]): void {
    const combined = [...failed, ...this.buffer];
    if (combined.length > MAX_RETAINED_EVENTS) {
      const overflow = combined.length - MAX_RETAINED_EVENTS;
      this.dropped += overflow;
      this.log.error(
        { droppedNow: overflow, droppedTotal: this.dropped, retained: MAX_RETAINED_EVENTS },
        '[audit] retention ceiling reached — audit evidence is being lost',
      );
    }
    this.buffer = combined.slice(0, MAX_RETAINED_EVENTS);
  }

  /** Flush buffered events to the database */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    // Swap buffer atomically
    const events = this.buffer;
    this.buffer = [];

    // How far the loop got. Everything before this index has been settled —
    // written, queued for retry, or dropped — so the outer catch must not
    // requeue it. Requeuing a written event retries it under the same primary
    // key, which fails, exhausts its attempts, and reports evidence as lost
    // that is sitting in the table.
    let settled = 0;

    try {
      const db = this.getDb();
      if (!db) {
        // Nothing was attempted, so nothing is unwritable — the events go back.
        // Discarding here treated an absent dependency as a verdict about the
        // evidence.
        this.consecutiveFlushFailures += 1;
        this.requeue(events);
        this.log.warn(
          { pending: this.buffer.length },
          '[audit] database unavailable — events retained for retry',
        );
        return;
      }

      const failed: BufferedAuditEvent[] = [];

      // Insert events using drizzle
      for (const event of events) {
        try {
          await db.insert(platformAuditLog).values({
            id: event.id,
            timestamp: event.timestamp,
            actorId: event.actor.userId,
            actorType: event.actor.kind,
            action: event.action,
            resourceType: event.target?.resourceType ?? null,
            resourceId: event.target?.resourceId ?? null,
            tenantId: event.actor.tenantId,
            details: event.details ?? null,
            ipAddress: event.request?.ipAddress ?? null,
            userAgent: event.request?.userAgent ?? null,
            category: event.category,
            outcome: event.outcome,
            actorContext: event.actor as Record<string, unknown>,
            target: event.target ? (event.target as Record<string, unknown>) : null,
            requestMetadata: event.request ? (event.request as Record<string, unknown>) : null,
          });
        } catch (err) {
          // A transient failure does not spend the budget: it is the
          // connection speaking, not this row, and the row is still writable.
          // The retention ceiling is what bounds an outage that never ends.
          if (!isDeterministicWriteError(err)) {
            failed.push({ ...event });
            settled += 1;
            continue;
          }
          const attempts = event.attempts + 1;
          if (attempts >= MAX_EVENT_ATTEMPTS) {
            // Unwritable rather than unlucky. Dropped deliberately so it cannot
            // stall the events behind it, and said at error level with its
            // identity so the loss is a fact somebody can act on.
            this.dropped += 1;
            this.log.error(
              {
                err,
                eventId: event.id,
                action: event.action,
                category: event.category,
                attempts,
                droppedTotal: this.dropped,
              },
              '[audit] event is unwritable after repeated attempts — dropping it',
            );
          } else {
            failed.push({ ...event, attempts });
          }
        }
        settled += 1;
      }

      if (failed.length > 0) this.requeue(failed);
      this.consecutiveFlushFailures = failed.length > 0 ? this.consecutiveFlushFailures + 1 : 0;

      // Observability, not evidence. Wrapped separately so a serializer that
      // chokes on one event cannot reach the outer handler and put an already
      // written batch back on the queue.
      try {
        for (const event of events) {
          this.log.info(
            {
              audit: true,
              category: event.category,
              action: event.action,
              outcome: event.outcome,
              actor: { userId: event.actor.userId, kind: event.actor.kind },
              target: event.target,
            },
            `Audit: ${event.action}`,
          );
        }
      } catch {
        // The rows are already durable; losing their log line is not a loss.
      }
    } catch (err) {
      // A failure out here is the connection or the driver rather than the
      // rows, so what it reached is still writable and goes back. Only what the
      // loop never settled: an event already written would otherwise be retried
      // under the same primary key, fail, exhaust its attempts, and be reported
      // as lost while sitting in the table.
      //
      // Memory pressure is bounded by the retention ceiling rather than by
      // discarding, which is the difference between a delay and a gap.
      this.consecutiveFlushFailures += 1;
      this.requeue(events.slice(settled).map((e) => ({ ...e, attempts: e.attempts + 1 })));
      this.log.error(
        { err, pending: this.buffer.length },
        '[audit] batch flush failed — events retained for retry',
      );
    } finally {
      this.flushing = false;
    }
  }
}

// ============================================================================
// Fastify Plugin
// ============================================================================

/**
 * Construct the service directly.
 *
 * Exists so the durability behaviour can be driven without a Fastify instance
 * and a live database: the properties worth testing here are what happens when
 * the write FAILS, and those are unreachable through the plugin.
 */
export function createAuditService(
  getDb: () => PostgresJsDatabase | null,
  log: FastifyInstance['log'],
  options?: { maxBufferSize?: number; flushIntervalMs?: number },
): AuditServiceImpl {
  return new AuditServiceImpl(getDb, log, options);
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: AuditServiceImpl;
  }
}

export const auditPlugin = fp(
  async (fastify: FastifyInstance) => {
    // Use a getter so we always resolve the latest db reference.
    // AppContext.db is typed as `unknown`; cast to PostgresJsDatabase at access time.
    const getDb = (): PostgresJsDatabase | null => {
      const ctx = fastify.appContext;
      if (!ctx?.db) return null;
      return ctx.db as PostgresJsDatabase;
    };

    const auditService = new AuditServiceImpl(getDb, fastify.log);

    auditService.start();
    fastify.decorate('audit', auditService);

    // Flush on shutdown
    fastify.addHook('onClose', async () => {
      await auditService.stop();
    });
  },
  { name: 'audit-plugin' },
);
