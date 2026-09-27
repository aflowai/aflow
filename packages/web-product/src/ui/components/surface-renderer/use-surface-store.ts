'use client';

/**
 * React hook for managing surface state.
 *
 * Wraps the framework-agnostic SurfaceStore from @aflow/surface-engine
 * with React state management (useReducer + useSyncExternalStore pattern).
 */
'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { SurfaceMutation, TypedSurfaceComponent } from '@aflow/schemas';
import { SurfaceStore, type SurfaceState } from '@aflow/surface-engine';

export interface UseSurfaceStoreReturn {
  /** Current surface state. */
  state: Readonly<SurfaceState>;
  /** Apply a mutation to the surface. */
  apply: (mutation: SurfaceMutation) => boolean;
  /** Get a component by ID. */
  getComponent: (id: string) => TypedSurfaceComponent | undefined;
  /** Get data at a JSON Pointer path. */
  getData: (pointer: string) => unknown;
  /** Set data at a JSON Pointer path (local-first form editing). */
  setLocalData: (pointer: string, value: unknown) => void;
  /** Reset the store. */
  reset: () => void;
  /** The underlying store instance. */
  store: SurfaceStore;
}

/**
 * Hook that manages a surface store and triggers React re-renders on mutations.
 */
export function useSurfaceStore(): UseSurfaceStoreReturn {
  const storeRef = useRef<SurfaceStore>(null);
  if (!storeRef.current) {
    storeRef.current = new SurfaceStore();
  }
  const store = storeRef.current;

  // Use useSyncExternalStore for concurrent-safe subscriptions
  const state = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        return store.subscribe(onStoreChange);
      },
      [store],
    ),
    () => store.getState(),
    () => store.getState(),
  );

  const apply = useCallback((mutation: SurfaceMutation) => store.apply(mutation), [store]);

  const getComponent = useCallback((id: string) => store.getComponent(id), [store]);

  const getData = useCallback((pointer: string) => store.getData(pointer), [store]);

  const setLocalData = useCallback(
    (pointer: string, value: unknown) => {
      // Create a synthetic updateDataModel mutation for local edits
      const mutation: SurfaceMutation = {
        type: 'updateDataModel',
        surfaceId: store.getState().surfaceId,
        messageId: `local-${Date.now()}`,
        catalogVersion: store.getState().catalogVersion,
        timestamp: new Date().toISOString(),
        dataModel: { [pointer]: value },
      };
      store.apply(mutation);
    },
    [store],
  );

  const reset = useCallback(() => {
    store.reset();
  }, [store]);

  return { state, apply, getComponent, getData, setLocalData, reset, store };
}
