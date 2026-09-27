/**
 * Everything inside the dashboard that both editions render.
 *
 * The chrome and the space gate are the product; what wraps them is not. A
 * hosted deployment has an account to admit and terms to accept before any of
 * this is reachable, and a local instance has neither — reaching the process is
 * the whole of the identity. So the wrapper is the named composition point: each
 * application supplies its own providers and whatever gates its edition actually
 * has, and hands the product here.
 *
 * Stated as a component rather than left as a shape each application repeats,
 * because two copies of a nesting order are two things to keep in step, and the
 * order is load-bearing — the shell reads the space the gate establishes.
 */
'use client';

import type { ReactNode } from 'react';

import { AppShellWrapper } from './app-shell.js';
import { SpaceGate } from './space-gate.js';

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <AppShellWrapper>
      <SpaceGate>{children}</SpaceGate>
    </AppShellWrapper>
  );
}
