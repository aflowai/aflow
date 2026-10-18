'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityDirectives } from '@aflow/schemas';
import { ApiError } from '../lib/query-client.js';
import { useApiMutation, useApiQuery } from './useApiQuery.js';

export type DirectivesLoadState = 'loading' | 'loaded' | 'error';
export type DirectivesSaveState = 'idle' | 'saving' | 'saved' | 'error';
export interface AgentDirectivesController {
  directives: EntityDirectives | null;
  loadState: DirectivesLoadState;
  loadError: string | null;
  saveState: DirectivesSaveState;
  saveError: string | null;
  edit: (update: (current: EntityDirectives) => EntityDirectives) => void;
}

export function useAgentDirectives(spaceId: string, open: boolean): AgentDirectivesController {
  const query = useApiQuery<{ directives: EntityDirectives | null }>({
    key: ['space', spaceId, 'agent-directives'],
    path: `/spaces/${spaceId}`,
    spaceId,
    enabled: open,
    staleTime: 0,
  });
  const mutation = useApiMutation<
    { directives: EntityDirectives; expectedDirectives: EntityDirectives | null },
    { directives: EntityDirectives }
  >({
    path: `/spaces/${spaceId}`,
    method: 'PATCH',
    spaceId,
    invalidate: [['space', spaceId], ['spaces']],
    onError: () => undefined,
  });
  const [directives, setDirectives] = useState<EntityDirectives | null>(null);
  const [saveState, setSaveState] = useState<DirectivesSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const live = useRef<EntityDirectives | null>(null);
  const saved = useRef<EntityDirectives | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<EntityDirectives | null>(null);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const conflicted = useRef(false);
  const mutate = useRef(mutation.mutateAsync);
  mutate.current = mutation.mutateAsync;

  useEffect(() => {
    if (!open || !query.data || dirty.current) return;
    live.current = query.data.directives;
    saved.current = query.data.directives;
    failed.current = false;
    conflicted.current = false;
    setDirectives(query.data.directives);
  }, [open, query.data]);

  const save = useCallback((next: EntityDirectives) => {
    setSaveState('saving');
    setSaveError(null);
    queue.current = queue.current.then(async () => {
      if (failed.current || live.current !== next) return;
      try {
        const result = await mutate.current({
          directives: next,
          expectedDirectives: saved.current,
        });
        saved.current = result.directives;
        if (live.current === next) {
          dirty.current = false;
          live.current = result.directives;
          setDirectives(result.directives);
          setSaveState('saved');
        }
      } catch (error) {
        failed.current = true;
        setSaveState('error');
        conflicted.current = error instanceof ApiError && error.status === 409;
        setSaveError(
          `${error instanceof Error ? error.message : String(error)}${conflicted.current ? ' Close and reopen settings to reload before retrying.' : ''}`,
        );
      }
    });
  }, []);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) saveRef.current(pending.current);
    },
    [],
  );
  useEffect(() => {
    if (open) return;
    if (failed.current) {
      dirty.current = false;
      failed.current = false;
    }
  }, [open]);

  const edit = useCallback((update: (current: EntityDirectives) => EntityDirectives) => {
    if (!live.current || conflicted.current) return;
    failed.current = false;
    const next = update(live.current);
    dirty.current = true;
    live.current = next;
    pending.current = next;
    setDirectives(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      saveRef.current(next);
    }, 450);
  }, []);
  const loadState: DirectivesLoadState =
    query.isError || (query.isSuccess && !query.data.directives)
      ? 'error'
      : directives
        ? 'loaded'
        : 'loading';
  return {
    directives,
    loadState,
    loadError:
      query.error?.message ??
      (query.isSuccess && !query.data.directives ? 'This space has no agent settings.' : null),
    saveState,
    saveError,
    edit,
  };
}
