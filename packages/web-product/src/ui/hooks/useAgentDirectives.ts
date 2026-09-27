'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EntityDirectives } from '@aflow/schemas';
import { useApi } from '../components/providers.js';

export type DirectivesLoadState = 'loading' | 'loaded' | 'error';
export type DirectivesSaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_DEBOUNCE_MS = 450;
const SAVED_BADGE_MS = 1600;

export interface AgentDirectivesController {
  directives: EntityDirectives | null;
  loadState: DirectivesLoadState;
  loadError: string | null;
  saveState: DirectivesSaveState;
  saveError: string | null;
  /** Apply an edit to the live directives and schedule a debounced PATCH. */
  edit: (update: (current: EntityDirectives) => EntityDirectives) => void;
}

/**
 * The agent's `spaces.directives`, loaded when a settings panel opens and
 * written back through the same PATCH the settings tab uses —
 * `modelDefaults` / `reasoningDefaults` / `capabilityDiscovery` are
 * non-constitutional, so the server applies them inline and busts the cached
 * SpaceContext for live sessions. Edits are agent-level (per space), never per
 * session.
 *
 * Reloading on each open is deliberate: a panel that cached its first read
 * would show model defaults a change made elsewhere has already replaced.
 */
export function useAgentDirectives(spaceId: string, open: boolean): AgentDirectivesController {
  const { apiUrl, headers } = useApi();
  const queryClient = useQueryClient();

  const [directives, setDirectives] = useState<EntityDirectives | null>(null);
  const [loadState, setLoadState] = useState<DirectivesLoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<DirectivesSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const directivesRef = useRef<EntityDirectives | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id so an out-of-order PATCH completion can't clobber the status
  // of a newer save.
  const saveSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    void (async () => {
      try {
        const res = await fetch(`${apiUrl}/spaces/${spaceId}`, {
          headers: { ...headers(), 'X-Space-ID': spaceId },
        });
        if (!res.ok) throw new Error(`Failed to load settings (${String(res.status)})`);
        const data = (await res.json()) as { directives?: EntityDirectives | null };
        if (cancelled) return;
        if (!data.directives) {
          setLoadError('This space is not in cybernetic mode.');
          setLoadState('error');
          return;
        }
        setDirectives(data.directives);
        directivesRef.current = data.directives;
        setLoadState('loaded');
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings');
        setLoadState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, apiUrl, headers, spaceId]);

  const doSave = useCallback(
    async (next: EntityDirectives) => {
      const seq = ++saveSeq.current;
      setSaveState('saving');
      setSaveError(null);
      try {
        const res = await fetch(`${apiUrl}/spaces/${spaceId}`, {
          method: 'PATCH',
          headers: { ...headers(), 'X-Space-ID': spaceId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ directives: next }),
        });
        if (!res.ok) {
          if (res.status === 403) {
            throw new Error('You do not have permission to change settings for this space.');
          }
          // A refused placement answers with the count that was over the cap.
          // That number is the whole content of the failure, so the server's
          // message is what the operator has to see, not the status code.
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `Save failed (${String(res.status)})`);
        }
        // A newer save started while this one was in flight — let it own the UI.
        if (seq !== saveSeq.current) return;
        setSaveState('saved');
        void queryClient.invalidateQueries({ queryKey: ['space', spaceId] });
        void queryClient.invalidateQueries({ queryKey: ['spaces'] });
        if (savedResetTimer.current) clearTimeout(savedResetTimer.current);
        savedResetTimer.current = setTimeout(() => {
          setSaveState('idle');
        }, SAVED_BADGE_MS);
      } catch (err) {
        if (seq !== saveSeq.current) return;
        setSaveError(err instanceof Error ? err.message : 'Save failed');
        setSaveState('error');
      }
    },
    [apiUrl, headers, spaceId, queryClient],
  );

  // The pending edit, held so unmount can flush it. A ref rather than state:
  // the cleanup below runs once and must see the latest value, not the one
  // captured when the effect was created.
  const pendingSave = useRef<EntityDirectives | null>(null);
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  // Flush a pending debounced save on unmount rather than dropping it. Closing
  // the chat within the debounce window otherwise discarded the edit silently —
  // no error, and the setting was simply back on the next visit.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedResetTimer.current) clearTimeout(savedResetTimer.current);
      const pending = pendingSave.current;
      pendingSave.current = null;
      if (pending) void doSaveRef.current(pending);
    },
    [],
  );

  const edit = useCallback((update: (current: EntityDirectives) => EntityDirectives) => {
    const current = directivesRef.current;
    if (!current) return;
    const next = update(current);
    directivesRef.current = next;
    setDirectives(next);
    pendingSave.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null;
      void doSaveRef.current(next);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  return { directives, loadState, loadError, saveState, saveError, edit };
}
