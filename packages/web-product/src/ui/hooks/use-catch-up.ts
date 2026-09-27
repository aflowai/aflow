'use client';

import type { CatchUpDelta } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/**
 * Where this person stopped reading a room.
 *
 * Asked once on arrival, and asking is what marks the room read — so the line
 * lands where they walked in and then holds still while they are reading,
 * rather than sliding down the page as new messages arrive underneath them.
 * The room shows the messages themselves; all that is wanted here is the
 * position to draw the line at.
 */
export function useCatchUp(sessionId: string | null): CatchUpDelta | undefined {
  const query = useApiQuery<CatchUpDelta>({
    key: ['session', sessionId ?? 'none', 'catch-up'],
    path: `/sessions/${sessionId ?? ''}/catch-up`,
    enabled: Boolean(sessionId),
    staleTime: 0,
  });
  return query.data;
}
