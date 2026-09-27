'use client';

/**
 * SurfaceRenderer — Entry point for rendering streamable surfaces.
 *
 * Accepts either:
 * - A stream of SurfaceMutation[] (real-time rendering as mutations arrive)
 * - A SurfaceSnapshot (hydrated rendering from persisted state)
 *
 * Manages the SurfaceStore lifecycle, renders the component tree from rootIds,
 * and dispatches actions and data model changes back to the caller.
 */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Column, Panel, Row, Spinner, Text } from '@aflow/design-system';
import type { SurfaceMutation, SurfaceSnapshot } from '@aflow/schemas';

import { useSurfaceStore } from './use-surface-store.js';
import { SurfaceComponentRenderer, type RendererContext } from './component-registry.js';

// =============================================================================
// CSS for smooth streaming transitions
// =============================================================================

const SURFACE_STYLES = `
@keyframes surfaceFadeIn {
  from { opacity: 0; filter: blur(4px); transform: translateY(4px); }
  to   { opacity: 1; filter: blur(0);   transform: translateY(0); }
}
.surface-container [data-surface-component] {
  animation: surfaceFadeIn 0.3s ease-out both;
}
.surface-container.surface-completed [data-surface-component] {
  animation: none;
  opacity: 1;
  filter: none;
}
`;

// =============================================================================
// Types
// =============================================================================

export interface SurfaceAction {
  componentId: string;
  action: Record<string, unknown>;
}

export interface SurfaceRendererProps {
  /** Stream mutations to apply incrementally. */
  mutations?: SurfaceMutation[] | undefined;
  /** Or hydrate from a persisted snapshot. */
  snapshot?: SurfaceSnapshot | undefined;
  /** Called when a component fires an action (button click, form submit, etc.). */
  onAction?: ((action: SurfaceAction) => void) | undefined;
  /** Called when the surface completes generation. */
  onComplete?: () => void;
  /** Called on surface errors. */
  onError?:
    | ((error: { code: string; message: string; recoverable?: boolean | undefined }) => void)
    | undefined;
  /** Optional className for the outer container. */
  className?: string | undefined;
  /** Show loading indicator when no content yet. */
  showLoading?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function SurfaceRenderer({
  mutations,
  snapshot,
  onAction,
  onComplete,
  onError,
  className,
  showLoading = true,
}: SurfaceRendererProps) {
  const { state, apply, setLocalData, store } = useSurfaceStore();
  const [surfaceError, setSurfaceError] = useState<{
    code: string;
    message: string;
    recoverable?: boolean | undefined;
  } | null>(null);

  // Track which mutations we've already applied to avoid re-processing
  const appliedCountRef = useRef(0);

  // Hydrate from snapshot on mount or when snapshot changes
  useEffect(() => {
    if (snapshot) {
      store.fromSnapshot(snapshot);
      appliedCountRef.current = 0;
    }
  }, [snapshot, store]);

  // Apply new mutations incrementally
  useEffect(() => {
    if (!mutations) return;

    const start = appliedCountRef.current;
    for (let i = start; i < mutations.length; i++) {
      const mutation = mutations[i];
      if (mutation === undefined) continue;

      // Handle error and completion signals
      if (mutation.type === 'surfaceError') {
        const err = {
          code: mutation.error.code,
          message: mutation.error.message,
          recoverable: mutation.error.recoverable,
        };
        setSurfaceError(err);
        onError?.(err);
      }

      if (mutation.type === 'completeSurface') {
        apply(mutation);
        onComplete?.();
      } else {
        apply(mutation);
      }
    }
    appliedCountRef.current = mutations.length;
  }, [mutations, apply, onComplete, onError]);

  // Action handler
  const handleAction = useCallback(
    (componentId: string, action: Record<string, unknown>) => {
      onAction?.({ componentId, action });
    },
    [onAction],
  );

  // Data change handler (for two-way form binding)
  const handleDataChange = useCallback(
    (pointer: string, value: unknown) => {
      setLocalData(pointer, value);
    },
    [setLocalData],
  );

  // Build renderer context
  const ctx: RendererContext = useMemo(
    () => ({
      state,
      onAction: handleAction,
      onDataChange: handleDataChange,
    }),
    [state, handleAction, handleDataChange],
  );

  // No content yet
  if (state.surfaceId === '' && !snapshot) {
    if (!showLoading) return null;
    return (
      <Column
        align="center"
        justify="center"
        gap="sm"
        style={{ padding: 'var(--space-6)', minHeight: '120px' }}
      >
        <Spinner size="md" />
        <Text color="secondary" size="sm">
          Generating surface…
        </Text>
      </Column>
    );
  }

  // Surface was deleted
  if (state.completed && state.components.size === 0) {
    return null;
  }

  // Empty surface (no root components yet but surface exists)
  if (state.rootIds.length === 0) {
    if (!state.completed && showLoading) {
      return (
        <Column
          align="center"
          justify="center"
          gap="sm"
          style={{ padding: 'var(--space-6)', minHeight: '120px' }}
        >
          <Spinner size="sm" />
          <Text color="secondary" size="sm">
            Building layout…
          </Text>
        </Column>
      );
    }
    return null;
  }

  // Surface error display
  if (surfaceError && state.components.size === 0) {
    return (
      <Panel>
        <Row gap="sm" align="start" style={{ padding: 'var(--space-4)' }}>
          <Text style={{ color: 'var(--color-danger-default)', flexShrink: 0 }}>⚠</Text>
          <Column gap="xs">
            <Text weight="bold" size="sm">
              Surface generation failed
            </Text>
            <Text size="sm" color="secondary">
              {surfaceError.message}
            </Text>
            {surfaceError.code && (
              <Text size="xs" color="secondary">
                Code: {surfaceError.code}
              </Text>
            )}
          </Column>
        </Row>
      </Panel>
    );
  }

  // Render the component tree from root IDs
  const containerClasses = [
    'surface-container',
    state.completed ? 'surface-completed' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <style>{SURFACE_STYLES}</style>
      <div className={containerClasses} data-surface-id={state.surfaceId}>
        {state.rootIds.map((rootId: string) => {
          const component = state.components.get(rootId);
          if (!component) return null;
          return <SurfaceComponentRenderer key={rootId} component={component} ctx={ctx} />;
        })}
        {!state.completed && showLoading && <StreamingIndicator />}
      </div>
    </>
  );
}

// =============================================================================
// Streaming indicator
// =============================================================================

function StreamingIndicator() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-2) 0',
        opacity: 0.6,
      }}
    >
      <Spinner size="sm" />
      <Text size="xs" color="secondary">
        Streaming…
      </Text>
    </div>
  );
}

// =============================================================================
// Convenience: snapshot-only renderer (no streaming)
// =============================================================================

export interface StaticSurfaceRendererProps {
  snapshot: SurfaceSnapshot;
  onAction?: (action: SurfaceAction) => void;
  className?: string;
}

/**
 * Renders a surface from a persisted snapshot. No streaming support.
 * Useful for displaying completed surfaces in run history, artifacts, etc.
 */
export function StaticSurfaceRenderer({
  snapshot,
  onAction,
  className,
}: StaticSurfaceRendererProps) {
  return (
    <SurfaceRenderer
      snapshot={snapshot}
      onAction={onAction}
      className={className}
      showLoading={false}
    />
  );
}
