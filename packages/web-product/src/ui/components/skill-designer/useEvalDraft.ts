'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CyberneticEvalSuite, EvalCriterion } from '@aflow/schemas';

import { useApi } from '../providers.js';

// ---------------------------------------------------------------------------
// Eval draft — the suite is a separate document from the workflow, so it gets
// its own draft + Save (POST to the operator eval-criteria route). Edits are
// recorded as a local draft suite; the ops to apply are derived by name-keyed
// diff against the loaded baseline at save time (rename ⇒ remove + add).
// ---------------------------------------------------------------------------

export type EvalTier =
  { scope: 'goal' } | { scope: 'trajectory' } | { scope: 'task'; taskId: string };

type EvalOp = Record<string, unknown>;

export interface EvalDraftActions {
  addCriterion: (tier: EvalTier, criterion: EvalCriterion) => void;
  updateCriterion: (tier: EvalTier, name: string, next: EvalCriterion) => void;
  removeCriterion: (tier: EvalTier, name: string) => void;
  discard: () => void;
}

export interface UseEvalDraft {
  draft: CyberneticEvalSuite | null;
  dirty: boolean;
  changeCount: number;
  saving: boolean;
  saveError: string | null;
  actions: EvalDraftActions;
  /** Apply the accumulated criterion changes. Rejects with a thrown error message in saveError. */
  save: (rationale: string) => Promise<void>;
}

function tierList(suite: CyberneticEvalSuite, tier: EvalTier): EvalCriterion[] {
  if (tier.scope === 'goal') return suite.goalCriteria;
  if (tier.scope === 'trajectory') return suite.trajectoryCriteria;
  return suite.taskCriteria[tier.taskId] ?? [];
}

function withTier(
  suite: CyberneticEvalSuite,
  tier: EvalTier,
  fn: (list: EvalCriterion[]) => EvalCriterion[],
): CyberneticEvalSuite {
  if (tier.scope === 'goal') return { ...suite, goalCriteria: fn(suite.goalCriteria) };
  if (tier.scope === 'trajectory')
    return { ...suite, trajectoryCriteria: fn(suite.trajectoryCriteria) };
  return {
    ...suite,
    taskCriteria: {
      ...suite.taskCriteria,
      [tier.taskId]: fn(suite.taskCriteria[tier.taskId] ?? []),
    },
  };
}

/** Local shell so the operator can author the first criterion before the suite
 *  exists; the apply path births the real suite from the resulting add op. */
function emptySuite(): CyberneticEvalSuite {
  return {
    createdAt: '',
    updatedAt: '',
    createdBy: 'operator',
    goalCriteria: [],
    trajectoryCriteria: [],
    taskCriteria: {},
    weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
  } as CyberneticEvalSuite;
}

function stripSource(c: EvalCriterion): EvalCriterion {
  const { source: _s, ...rest } = c as EvalCriterion & { source?: unknown };
  void _s;
  return rest as EvalCriterion;
}

/** Name-keyed diff → eval-criterion ops (provenance is set server-side). */
function suiteToOps(base: CyberneticEvalSuite, draft: CyberneticEvalSuite, slug: string): EvalOp[] {
  const taskIds = new Set([...Object.keys(base.taskCriteria), ...Object.keys(draft.taskCriteria)]);
  const tiers: EvalTier[] = [
    { scope: 'goal' },
    { scope: 'trajectory' },
    ...[...taskIds].map((taskId) => ({ scope: 'task', taskId }) as EvalTier),
  ];
  const ops: EvalOp[] = [];
  for (const tier of tiers) {
    const baseByName = new Map(tierList(base, tier).map((c) => [c.name, c]));
    const draftByName = new Map(tierList(draft, tier).map((c) => [c.name, c]));
    for (const [name, c] of draftByName) {
      const prev = baseByName.get(name);
      if (!prev) {
        ops.push({
          op: 'eval.criterion.add',
          skillSlug: slug,
          targetScope: tier.scope,
          ...(tier.scope === 'task' ? { taskId: tier.taskId } : {}),
          criterion: stripSource(c),
        });
      } else if (JSON.stringify(stripSource(c)) !== JSON.stringify(stripSource(prev))) {
        ops.push({
          op: 'eval.criterion.update',
          skillSlug: slug,
          criterionId: name,
          patch: stripSource(c),
        });
      }
    }
    for (const name of baseByName.keys()) {
      if (!draftByName.has(name)) {
        ops.push({ op: 'eval.criterion.remove', skillSlug: slug, criterionId: name });
      }
    }
  }
  return ops;
}

export function useEvalDraft({
  baseline,
  spaceId,
  slug,
}: {
  baseline: CyberneticEvalSuite | null;
  spaceId: string;
  slug: string;
}): UseEvalDraft {
  const { apiUrl, headers, authFetch } = useApi();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<CyberneticEvalSuite | null>(baseline);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const syncedAt = useRef<string | null>(baseline?.updatedAt ?? null);

  // Resync the draft when the persisted suite actually changes (after a save, or
  // a skill switch) — keyed on updatedAt so a same-data refetch never clobbers edits.
  useEffect(() => {
    const stamp = baseline?.updatedAt ?? null;
    if (stamp !== syncedAt.current) {
      syncedAt.current = stamp;
      setDraft(baseline);
      setSaveError(null);
    }
  }, [baseline]);

  const ops = useMemo(
    () => suiteToOps(baseline ?? emptySuite(), draft ?? emptySuite(), slug),
    [baseline, draft, slug],
  );

  const actions = useMemo<EvalDraftActions>(
    () => ({
      addCriterion: (tier, criterion) => {
        setDraft((d) => withTier(d ?? emptySuite(), tier, (l) => [...l, criterion]));
      },
      updateCriterion: (tier, name, next) => {
        setDraft((d) =>
          d ? withTier(d, tier, (l) => l.map((c) => (c.name === name ? next : c))) : d,
        );
      },
      removeCriterion: (tier, name) => {
        setDraft((d) => (d ? withTier(d, tier, (l) => l.filter((c) => c.name !== name)) : d));
      },
      discard: () => {
        setDraft(baseline);
        setSaveError(null);
      },
    }),
    [baseline],
  );

  const save = useCallback(
    async (rationale: string) => {
      if (ops.length === 0) return;
      setSaving(true);
      setSaveError(null);
      try {
        const h = headers();
        h['X-Space-ID'] = spaceId;
        h['Content-Type'] = 'application/json';
        const res = await authFetch(`${apiUrl}/spaces/${spaceId}/workflows/${slug}/eval-criteria`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ ops: ops.map((o) => ({ ...o, rationale })), rationale }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          setSaveError(body?.message ?? `Save failed (HTTP ${String(res.status)})`);
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: ['space', spaceId, 'workflow', slug, 'evals'],
        });
      } finally {
        setSaving(false);
      }
    },
    [ops, apiUrl, authFetch, headers, spaceId, slug, queryClient],
  );

  return {
    draft,
    dirty: ops.length > 0,
    changeCount: ops.length,
    saving,
    saveError,
    actions,
    save,
  };
}
