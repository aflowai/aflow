'use client';

import { useQueryClient } from '@tanstack/react-query';

import { useApiMutation, useApiQuery } from './useApiQuery.js';
import { useSpaceEntityEventListener } from './use-space-entity-events.js';
import type { SessionMetadata } from '../lib/types.js';

export { UNTITLED_CONVERSATION, conversationTitle } from '../lib/conversation-title.js';

/**
 * Refresh conversation names when the background job finishes one.
 *
 * Listens on the space channel rather than the open session's own stream: the
 * conversation being named is usually not the one anyone has open, and a row
 * in a list nobody subscribed to would otherwise stay stale until the next
 * refetch. One subscription for the whole list, through the refcounted broker.
 */
export function useSessionMetadataRefresh(spaceId: string | null): void {
  const queryClient = useQueryClient();
  useSpaceEntityEventListener(spaceId, (event) => {
    if (!spaceId || event.eventType !== 'entity.session.described') return;
    void queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'sessions'] });
  });
}

interface RenameInput {
  sessionId: string;
  /** Null hands the conversation back to its automatic name. */
  title: string | null;
  expectedRevision?: number;
}

export interface UseSessionRenameResult {
  /**
   * Resolves to null when the rename was refused — a name someone else changed
   * first, or a conversation whose record has not been stored yet. The reason
   * is already on screen as a toast by then, so there is nothing for the caller
   * to do with the failure but leave the old name showing.
   */
  rename: (input: RenameInput) => Promise<{ metadata: SessionMetadata } | null>;
  regenerate: (sessionId: string) => Promise<unknown>;
  isRenaming: boolean;
}

export function useSessionRename(spaceId: string): UseSessionRenameResult {
  const queryClient = useQueryClient();

  const renameMutation = useApiMutation<RenameInput, { metadata: SessionMetadata }>({
    path: (input) => `/sessions/${input.sessionId}/metadata`,
    method: 'PATCH',
    spaceId,
    serialize: (input) =>
      JSON.stringify({
        title: input.title,
        ...(input.expectedRevision !== undefined
          ? { expectedRevision: input.expectedRevision }
          : {}),
      }),
    // The response carries the committed name, so the header it was typed in
    // reads it directly rather than waiting out its own staleness or a round
    // trip through the space channel. The list still refetches — its rows
    // carry more than the name.
    onSuccess: (data, input) => {
      queryClient.setQueryData(['session', input.sessionId, 'metadata'], data);
      void queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'sessions'] });
    },
  });

  const regenerateMutation = useApiMutation<string>({
    path: (sessionId) => `/sessions/${sessionId}/metadata/regenerate`,
    method: 'POST',
    spaceId,
    serialize: () => JSON.stringify({}),
    // Deliberately no invalidation: the request was accepted, not applied.
    // The name arrives on the space channel when it has actually been written.
  });

  return {
    rename: (input) => renameMutation.mutateAsync(input).catch(() => null),
    regenerate: (sessionId) => regenerateMutation.mutateAsync(sessionId).catch(() => null),
    isRenaming: renameMutation.isPending,
  };
}

export interface SessionMetadataDetailPayload {
  metadata: SessionMetadata & {
    provenance: {
      modelRef: string;
      modelId: string;
      providerId: string;
      coverage: 'full' | 'partial';
      generatedAt: string;
    } | null;
    diagnostic: { code: string; message: string; retryable: boolean } | null;
  };
}

/**
 * The open conversation's own name and synopsis.
 *
 * A separate read from the list because a deep link can open a conversation
 * older than the recent window, and because the header wants the diagnostic
 * the list rows have no room for. Refreshed off the space channel, so the name
 * appears in the header the moment the background job writes it.
 */
export function useConversationMetadata(
  spaceId: string | null,
  sessionId: string | null,
): SessionMetadataDetailPayload['metadata'] | null {
  const queryClient = useQueryClient();
  const query = useApiQuery<SessionMetadataDetailPayload>({
    key: ['session', sessionId ?? 'none', 'metadata'],
    path: `/sessions/${sessionId ?? ''}/metadata`,
    enabled: sessionId !== null && (spaceId ?? '').length > 0,
    ...(spaceId ? { spaceId } : {}),
    staleTime: 30_000,
  });

  useSpaceEntityEventListener(spaceId, (event) => {
    if (event.eventType !== 'entity.session.described') return;
    if (sessionId === null || event.causedBySessionId !== sessionId) return;
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId, 'metadata'] });
  });

  return query.data?.metadata ?? null;
}
