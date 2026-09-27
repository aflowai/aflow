import type { Redis } from 'ioredis';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoachFeedbackEntry {
  eventType: 'entity.coach.ratified' | 'entity.coach.rejected' | 'entity.coach.apply_failed';
  timestamp: number;
  summary: string;
  payload: Record<string, unknown>;
}

const COACH_FEEDBACK_EVENT_TYPES = new Set([
  'entity.coach.ratified',
  'entity.coach.rejected',
  'entity.coach.apply_failed',
]);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load recent Coach ratification/rejection events for a space.
 *
 * Reads from the entity events stream in reverse chronological order,
 * filtering for coach feedback events, capped at `limit`.
 *
 * @param redis - Redis client
 * @param tenantId - Tenant ID
 * @param spaceId - Space ID
 * @param limit - Max entries to return (sourced from EntityDirectives.learningPolicy.coachFeedbackHistorySize)
 */
export async function loadCoachFeedback(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  limit: number,
): Promise<CoachFeedbackEntry[]> {
  if (limit <= 0) return [];

  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);

  // Read recent events in reverse order. Oversample by 5x since not all
  // events are coach feedback — reduces round-trips for typical mixes.
  const rawEntries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', limit * 5);
  if (rawEntries.length === 0) return [];

  const results: CoachFeedbackEntry[] = [];

  for (const [, fields] of rawEntries) {
    if (results.length >= limit) break;

    // Parse flat stream fields into a record
    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    const eventType = fieldObj['eventType'];
    if (!eventType || !COACH_FEEDBACK_EVENT_TYPES.has(eventType)) continue;

    const timestampStr = fieldObj['timestamp'];
    const timestamp = timestampStr ? Number(timestampStr) : Date.now();
    const summary = fieldObj['summary'] ?? '';

    let payload: Record<string, unknown> = {};
    const payloadStr = fieldObj['payload'];
    if (payloadStr) {
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>;
      } catch {
        // Keep empty payload
      }
    }

    results.push({
      eventType: eventType as CoachFeedbackEntry['eventType'],
      timestamp,
      summary,
      payload,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Prompt formatter
// ---------------------------------------------------------------------------

/**
 * Format coach feedback entries for inclusion in the Coach's review prompt.
 */
export function formatCoachFeedbackForPrompt(entries: CoachFeedbackEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((e) => {
    const date = new Date(e.timestamp).toISOString().slice(0, 10);
    const status =
      e.eventType === 'entity.coach.ratified'
        ? 'RATIFIED'
        : e.eventType === 'entity.coach.apply_failed'
          ? 'APPLY_FAILED'
          : 'REJECTED';
    return `- ${date} ${status} "${e.summary}"`;
  });

  return [
    'Recent proposal history:',
    ...lines,
    '',
    'Do not re-propose rejected items unless you have new evidence. Apply-failed proposals are proposals that passed pre-ratification preview but lost a race against another mutation — re-author with fresh context if the underlying issue still holds. Patterns that were ratified are valid examples to build on.',
  ].join('\n');
}
