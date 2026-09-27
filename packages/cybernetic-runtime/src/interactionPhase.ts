import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { InteractionPhaseValue } from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface InteractionPhaseInputs {
  helmsmanStatus: 'idle' | 'running' | 'paused';
  activeRunnerSessions: Array<{ sessionId: string; skillId: string }>;
  activeCoachSessions: Array<{ sessionId: string; skillId?: string }>;
}

export type InteractionPhase =
  | { phase: 'idle' }
  | { phase: 'decide' }
  | { phase: 'execute'; skillId: string }
  | { phase: 'review'; skillId?: string };

// ============================================================================
// Pure reducer
// ============================================================================

/**
 * Compute the current interaction phase from observable state.
 *
 * Precedence: review > execute > decide > idle
 */
export function computeInteractionPhase(inputs: InteractionPhaseInputs): InteractionPhase {
  // Review takes highest precedence
  if (inputs.activeCoachSessions.length > 0) {
    const first = inputs.activeCoachSessions[0];
    const skillId = first?.skillId;
    if (skillId) {
      return { phase: 'review', skillId };
    }
    return { phase: 'review' };
  }

  // Execute takes second precedence
  if (inputs.activeRunnerSessions.length > 0) {
    const first = inputs.activeRunnerSessions[0];
    return first ? { phase: 'execute', skillId: first.skillId } : { phase: 'execute', skillId: '' };
  }

  // Decide if Helmsman is actively processing
  if (inputs.helmsmanStatus === 'running' || inputs.helmsmanStatus === 'paused') {
    return { phase: 'decide' };
  }

  return { phase: 'idle' };
}

// ============================================================================
// Debounced emitter
// ============================================================================

interface PhaseRecord {
  lastPhase: InteractionPhaseValue;
  lastSkillId: string | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * In-memory state per space for debouncing phase transitions.
 * Prevents flapping between execute and review within 500ms.
 */
const phaseState = new Map<string, PhaseRecord>();

const DEBOUNCE_MS = 500;

/**
 * Emit an `entity.interaction.phase` event if the phase changed,
 * with 500ms server-side debounce to prevent flapping.
 */
export function emitPhaseIfChanged(params: {
  tenantId: string;
  spaceId: string;
  redis: Redis;
  inputs: InteractionPhaseInputs;
}): void {
  const { tenantId, spaceId, redis, inputs } = params;
  const phase = computeInteractionPhase(inputs);
  const key = `${tenantId}:${spaceId}`;
  const current = phaseState.get(key);

  const skillId = 'skillId' in phase ? phase.skillId : undefined;

  // No change — skip
  if (current?.lastPhase === phase.phase && current?.lastSkillId === skillId) {
    return;
  }

  // Clear any pending debounce
  if (current?.debounceTimer) {
    clearTimeout(current.debounceTimer);
  }

  // Set debounce timer
  const timer = setTimeout(() => {
    const now = new Date().toISOString();
    phaseState.set(key, {
      lastPhase: phase.phase,
      lastSkillId: skillId,
      debounceTimer: undefined,
    });

    appendEntityEvent(redis, {
      tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.interaction.phase',
        spaceId,
        tenantId,
        timestamp: Date.now(),
        payload: {
          phase: phase.phase,
          ...(skillId ? { skillId } : {}),
          computedAt: now,
        },
        summary: formatPhaseSummary(phase),
      },
    }).catch((err: unknown) => {
      getCyberneticLogger().warn('interactionPhase: failed to emit phase event', {
        error: String(err),
      });
    });
  }, DEBOUNCE_MS);

  phaseState.set(key, {
    lastPhase: current?.lastPhase ?? 'idle',
    lastSkillId: current?.lastSkillId,
    debounceTimer: timer,
  });
}

function formatPhaseSummary(phase: InteractionPhase): string {
  switch (phase.phase) {
    case 'idle':
      return 'Interaction idle';
    case 'decide':
      return 'Planning...';
    case 'execute':
      return `Acting on ${phase.skillId}...`;
    case 'review':
      return phase.skillId ? `Reflecting on ${phase.skillId}...` : 'Reflecting...';
  }
}

/** Reset debounce state for a space. Useful in tests. */
export function resetPhaseState(tenantId: string, spaceId: string): void {
  const key = `${tenantId}:${spaceId}`;
  const current = phaseState.get(key);
  if (current?.debounceTimer) {
    clearTimeout(current.debounceTimer);
  }
  phaseState.delete(key);
}
