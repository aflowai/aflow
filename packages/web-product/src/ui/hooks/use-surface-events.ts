'use client';

/**
 * Hook that extracts surface mutations from run events.
 *
 * Listens to the run event stream (SSE) and collects SurfaceMutation messages
 * from SurfaceUpdate events. Returns mutations ready to feed into SurfaceRenderer.
 *
 * Two sources of surface data:
 * 1. SurfaceUpdate events — real-time mutations streamed during execution
 * 2. StepSucceeded events — may contain surfaceSnapshotRef in output
 */
'use client';

import { useMemo } from 'react';
import type { SurfaceMutation } from '@aflow/schemas';
import type { SessionEvent } from '../lib/types.js';

export interface UseSurfaceEventsReturn {
  /** All surface mutations received so far, in order. */
  mutations: SurfaceMutation[];
  /** Whether any surface data has been received. */
  hasSurface: boolean;
  /** The surface ID (from the first SurfaceUpdate event). */
  surfaceId: string | null;
  /** Whether the surface is complete (completeSurface mutation received). */
  isComplete: boolean;
}

/**
 * Extract surface mutations from run events.
 * Pass the events array from useRunEvents().
 */
export function useSurfaceEvents(events: SessionEvent[]): UseSurfaceEventsReturn {
  return useMemo(() => {
    const mutations: SurfaceMutation[] = [];
    let surfaceId: string | null = null;
    let isComplete = false;

    for (const event of events) {
      if (event.eventType === 'SurfaceUpdate' && event.surfaceMutations) {
        for (const raw of event.surfaceMutations) {
          // Surface mutations arrive as Record<string, unknown> from JSON
          const mutation = raw as unknown as SurfaceMutation;
          mutations.push(mutation);

          if (!surfaceId && event.surfaceId) {
            surfaceId = event.surfaceId;
          }
          if (mutation.type === 'completeSurface') {
            isComplete = true;
          }
        }
      }
    }

    return {
      mutations,
      hasSurface: mutations.length > 0,
      surfaceId,
      isComplete,
    };
  }, [events]);
}
