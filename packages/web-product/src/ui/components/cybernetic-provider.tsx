'use client';

import { useCallback, useEffect, useState, createContext, useContext, type ReactNode } from 'react';
import type { EntityDirectives } from '@aflow/schemas';
import { Spinner, Button, Text, Column } from '@aflow/design-system';
import { useSpace } from './providers.js';
import { getRealtimeClient } from '../lib/realtimeClient.js';
import { useSpaceDetailQuery } from '../hooks/use-space-detail.js';

// ============================================================================
// CyberneticProvider — live directives for a cybernetic space.
//
// Mounted wherever a surface needs the cybernetic identity context:
//   • skills / directives / training via `CyberneticSpaceShell`
//   • companion pane: app/(dashboard)/chat/page.tsx
//

interface CyberneticContextValue {
  spaceId: string;
  directives: EntityDirectives;
  isConnected: boolean;
  registerImperativeRefresh: (fn: () => void | Promise<void>) => () => void;
  triggerImperativeRefresh: () => Promise<void>;
}

const CyberneticContext = createContext<CyberneticContextValue | null>(null);

export function useCybernetic(): CyberneticContextValue {
  const ctx = useContext(CyberneticContext);
  if (!ctx) {
    throw new Error(
      'useCybernetic must be used within <CyberneticProvider>. ' +
        'Mount the provider in the nearest cybernetic surface (console or chat companion pane).',
    );
  }
  return ctx;
}

export function useOptionalCybernetic(): CyberneticContextValue | null {
  return useContext(CyberneticContext);
}

interface CyberneticProviderProps {
  /** Space ID. Every space is cybernetic (directives always set). */
  spaceId: string;
  /** Rendered while directives load. Defaults to a centered spinner. */
  loadingFallback?: ReactNode;
  children: ReactNode;
}

export function CyberneticProvider({
  spaceId,
  loadingFallback,
  children,
}: CyberneticProviderProps) {
  const { spaces, isLoading: spacesLoading } = useSpace();
  const space = spaces.find((s) => s.id === spaceId);

  // The space-detail key, so a second mount reads the cache, and so does any
  // other holder of the key on the page (the local edition's space gate).
  const detail = useSpaceDetailQuery(space?.id ?? null);
  const directives = (detail.data?.directives ?? null) as EntityDirectives | null;
  const directivesError = !directives && (detail.isError || detail.isSuccess);
  const refetchDetail = detail.refetch;
  const retryDirectives = useCallback(() => {
    void refetchDetail();
  }, [refetchDetail]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!space) return;
    const client = getRealtimeClient();
    setIsConnected(client.getStatus().isConnected);
    const unsubscribeStatus = client.subscribeStatus((s) => {
      setIsConnected(s.isConnected);
    });
    return () => {
      unsubscribeStatus();
    };
  }, [space]);

  const registerImperativeRefresh = useCallback((fn: () => void | Promise<void>) => {
    return registerCyberneticRefreshSubscriber(fn);
  }, []);

  const triggerImperativeRefresh = useCallback(async () => {
    await triggerCyberneticRefresh();
  }, []);

  if (spacesLoading || !space) {
    return <>{loadingFallback ?? <CenteredSpinner label="Loading space" />}</>;
  }

  // Directives failed to load (network). Every space has directives, so this
  // is transient — surface a retry rather than rendering children unwrapped,
  // which would crash any consumer that calls the required useCybernetic().
  if (directivesError) {
    return <DirectivesError onRetry={retryDirectives} />;
  }

  if (!directives) {
    return <>{loadingFallback ?? <CenteredSpinner label="Loading entity" />}</>;
  }

  return (
    <CyberneticContext.Provider
      value={{
        spaceId: space.id,
        directives,
        isConnected,
        registerImperativeRefresh,
        triggerImperativeRefresh,
      }}
    >
      {children}
    </CyberneticContext.Provider>
  );
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
      }}
    >
      <Spinner size="xl" label={label} />
    </div>
  );
}

function DirectivesError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
      }}
    >
      <Column gap="md" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 360 }}>
        <Text variant="muted">Couldn&apos;t load this space. Check your connection and retry.</Text>
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </Column>
    </div>
  );
}

// ============================================================================

const cyberneticRefreshSubscribers = new Set<() => void | Promise<void>>();

function registerCyberneticRefreshSubscriber(fn: () => void | Promise<void>): () => void {
  cyberneticRefreshSubscribers.add(fn);
  return () => {
    cyberneticRefreshSubscribers.delete(fn);
  };
}

export async function triggerCyberneticRefresh(): Promise<void> {
  const fns = Array.from(cyberneticRefreshSubscribers);
  await Promise.allSettled(fns.map((fn) => Promise.resolve(fn())));
}
