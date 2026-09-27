'use client';

import type { SessionEvent } from '../lib/types.js';
import { useSessionEvents } from './use-session-events.js';

export type { SessionEvent };

export const useRunEvents = useSessionEvents;
