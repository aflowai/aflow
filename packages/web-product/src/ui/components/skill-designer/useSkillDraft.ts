'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Workflow, WorkflowTask, Outcome, SkillValidity } from '@aflow/schemas';

import { useApi } from '../providers.js';

// ---------------------------------------------------------------------------
// Draft actions
// ---------------------------------------------------------------------------

type DispatchKind = 'agent' | 'operation' | 'human';

export interface SkillDraftActions {
  patchWorkflow: (patch: Partial<Workflow>) => void;
  patchTask: (taskId: string, patch: Partial<WorkflowTask>) => void;
  setDispatch: (taskId: string, kind: DispatchKind) => void;
  addTask: () => void;
  removeTask: (taskId: string) => void;
  addDependency: (from: string, to: string) => void;
  /** Wire producer→consumer as a (whole-output) task_output binding + dependency. */
  bindWholeOutput: (targetTaskId: string, producerTaskId: string) => void;
  removeDependency: (from: string, to: string) => void;
  patchOutcome: (id: string, patch: Partial<Outcome>) => void;
  addOutcome: () => void;
  removeOutcome: (id: string) => void;
}

type Action =
  | { t: 'patchWorkflow'; patch: Partial<Workflow> }
  | { t: 'patchTask'; taskId: string; patch: Partial<WorkflowTask> }
  | { t: 'setDispatch'; taskId: string; kind: DispatchKind }
  | { t: 'addTask' }
  | { t: 'removeTask'; taskId: string }
  | { t: 'addDep'; from: string; to: string }
  | { t: 'bindOutput'; target: string; producer: string }
  | { t: 'removeDep'; from: string; to: string }
  | { t: 'patchOutcome'; id: string; patch: Partial<Outcome> }
  | { t: 'addOutcome' }
  | { t: 'removeOutcome'; id: string };

function uniqueId(prefix: string, taken: Set<string>): string {
  let n = taken.size + 1;
  let id = `${prefix}-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `${prefix}-${n}`;
  }
  return id;
}

/** True when every key in `patch` already equals the target's value (shallow) —
 *  so a no-op edit doesn't churn a new object, false dirty, or an undo entry. */
function isNoOp(target: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([k, v]) => target[k] === v);
}

function applyAction(wf: Workflow, action: Action): Workflow {
  switch (action.t) {
    case 'patchWorkflow':
      return isNoOp(wf as unknown as Record<string, unknown>, action.patch)
        ? wf
        : { ...wf, ...action.patch };
    case 'patchTask': {
      const target = wf.tasks.find((t) => t.taskId === action.taskId);
      if (!target || isNoOp(target as unknown as Record<string, unknown>, action.patch)) return wf;
      return {
        ...wf,
        tasks: wf.tasks.map((t) => (t.taskId === action.taskId ? { ...t, ...action.patch } : t)),
      };
    }
    case 'setDispatch':
      return {
        ...wf,
        tasks: wf.tasks.map((t) => {
          if (t.taskId !== action.taskId) return t;
          // Strip every dispatch field, then set only the chosen family — the
          // schema enforces exactly one of agent/operation/human.
          const { agent, operation, pauseInstruction, intent, approves, actionPreview, ...rest } =
            t;
          void approves;
          void actionPreview;
          if (action.kind === 'agent') return { ...rest, agent: agent ?? 'cybernetic-runner' };
          if (action.kind === 'operation') return { ...rest, operation: operation ?? '' };
          return {
            ...rest,
            pauseInstruction: pauseInstruction ?? 'Describe what to collect.',
            intent: intent ?? 'collect',
          };
        }),
      };
    case 'addTask': {
      const taken = new Set(wf.tasks.map((t) => t.taskId));
      const taskId = uniqueId('task', taken);
      const next: WorkflowTask = {
        taskId,
        name: 'New task',
        goal: 'Describe what this task should do.',
        agent: 'cybernetic-runner',
      } as WorkflowTask;
      return { ...wf, tasks: [...wf.tasks, next] };
    }
    case 'removeTask':
      return {
        ...wf,
        tasks: wf.tasks
          .filter((t) => t.taskId !== action.taskId)
          .map((t) => ({
            ...t,
            ...(t.dependsOn ? { dependsOn: t.dependsOn.filter((d) => d !== action.taskId) } : {}),
          })),
      };
    case 'addDep':
      if (action.from === action.to) return wf;
      return {
        ...wf,
        tasks: wf.tasks.map((t) => {
          if (t.taskId !== action.to) return t;
          const deps = t.dependsOn ?? [];
          return deps.includes(action.from) ? t : { ...t, dependsOn: [...deps, action.from] };
        }),
      };
    case 'bindOutput':
      return {
        ...wf,
        tasks: wf.tasks.map((t) => {
          if (t.taskId !== action.target) return t;
          const taken = new Set(Object.keys(t.inputBindings ?? {}));
          let n = taken.size + 1;
          let key = `input${n}`;
          while (taken.has(key)) {
            n += 1;
            key = `input${n}`;
          }
          const inputBindings = {
            ...(t.inputBindings ?? {}),
            [key]: { kind: 'task_output', taskId: action.producer },
          } as unknown as WorkflowTask['inputBindings'];
          const dependsOn = [...new Set([...(t.dependsOn ?? []), action.producer])];
          return { ...t, inputBindings, dependsOn };
        }),
      };
    case 'removeDep':
      return {
        ...wf,
        tasks: wf.tasks.map((t) =>
          t.taskId === action.to && t.dependsOn
            ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== action.from) }
            : t,
        ),
      };
    case 'patchOutcome':
      return {
        ...wf,
        outcomes: wf.outcomes.map((o) => (o.id === action.id ? { ...o, ...action.patch } : o)),
      };
    case 'addOutcome': {
      const taken = new Set(wf.outcomes.map((o) => o.id));
      const id = uniqueId('outcome', taken);
      const next: Outcome = {
        id,
        name: 'New outcome',
        evaluator: { type: 'manual', instruction: 'Describe the pass condition.' },
      };
      return { ...wf, outcomes: [...wf.outcomes, next] };
    }
    case 'removeOutcome':
      return { ...wf, outcomes: wf.outcomes.filter((o) => o.id !== action.id) };
    default:
      return wf;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface DraftState {
  past: Workflow[];
  present: Workflow;
  future: Workflow[];
}

export interface UseSkillDraft {
  draft: Workflow;
  /** Last saved workflow — the baseline a draft diffs against. */
  baseline: Workflow;
  dirty: boolean;
  validity: SkillValidity | undefined;
  validating: boolean;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  actions: SkillDraftActions;
  undo: () => void;
  redo: () => void;
  discard: () => void;
  save: () => Promise<void>;
}

export function useSkillDraft({
  workflow,
  contractValidity,
  spaceId,
  slug,
}: {
  workflow: Workflow;
  contractValidity?: SkillValidity | undefined;
  spaceId: string;
  slug: string;
}): UseSkillDraft {
  const { apiUrl, headers, authFetch } = useApi();
  const queryClient = useQueryClient();

  const [baseline, setBaseline] = useState<Workflow>(workflow);
  const [state, setState] = useState<DraftState>({ past: [], present: workflow, future: [] });
  const [validity, setValidity] = useState<SkillValidity | undefined>(contractValidity);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = state.present !== baseline;

  // Warn before a hard navigation / tab close drops unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty]);

  // Re-sync when the loaded skill changes (switch) or is refreshed while clean.
  useEffect(() => {
    if (workflow.slug !== baseline.slug || (workflow !== baseline && state.present === baseline)) {
      lastCoalesce.current = null;
      setBaseline(workflow);
      setState({ past: [], present: workflow, future: [] });
      setValidity(contractValidity);
      setSaveError(null);
    }
  }, [workflow]);

  // Consecutive edits sharing a coalesce key (e.g. typing in one field) collapse
  // into a single undo entry instead of one per keystroke.
  const lastCoalesce = useRef<string | null>(null);
  const dispatch = useCallback((action: Action, coalesceKey?: string) => {
    setState((s) => {
      const next = applyAction(s.present, action);
      if (next === s.present) return s;
      if (coalesceKey && coalesceKey === lastCoalesce.current) {
        return { ...s, present: next, future: [] };
      }
      return { past: [...s.past, s.present].slice(-100), present: next, future: [] };
    });
    lastCoalesce.current = coalesceKey ?? null;
  }, []);

  const keyOf = (prefix: string, patch: object) =>
    `${prefix}:${Object.keys(patch).sort().join(',')}`;

  const actions = useMemo<SkillDraftActions>(
    () => ({
      patchWorkflow: (patch) => {
        dispatch({ t: 'patchWorkflow', patch }, keyOf('wf', patch));
      },
      patchTask: (taskId, patch) => {
        dispatch({ t: 'patchTask', taskId, patch }, keyOf(`task:${taskId}`, patch));
      },
      setDispatch: (taskId, kind) => {
        dispatch({ t: 'setDispatch', taskId, kind });
      },
      addTask: () => {
        dispatch({ t: 'addTask' });
      },
      removeTask: (taskId) => {
        dispatch({ t: 'removeTask', taskId });
      },
      addDependency: (from, to) => {
        dispatch({ t: 'addDep', from, to });
      },
      bindWholeOutput: (target, producer) => {
        dispatch({ t: 'bindOutput', target, producer });
      },
      removeDependency: (from, to) => {
        dispatch({ t: 'removeDep', from, to });
      },
      patchOutcome: (id, patch) => {
        dispatch({ t: 'patchOutcome', id, patch }, keyOf(`outcome:${id}`, patch));
      },
      addOutcome: () => {
        dispatch({ t: 'addOutcome' });
      },
      removeOutcome: (id) => {
        dispatch({ t: 'removeOutcome', id });
      },
    }),
    [dispatch],
  );

  const undo = useCallback(() => {
    lastCoalesce.current = null;
    setState((s) => {
      const prev = s.past[s.past.length - 1];
      if (prev === undefined) return s;
      return { past: s.past.slice(0, -1), present: prev, future: [s.present, ...s.future] };
    });
  }, []);

  const redo = useCallback(() => {
    lastCoalesce.current = null;
    setState((s) => {
      const next = s.future[0];
      if (next === undefined) return s;
      return { past: [...s.past, s.present], present: next, future: s.future.slice(1) };
    });
  }, []);

  const discard = useCallback(() => {
    lastCoalesce.current = null;
    setState({ past: [], present: baseline, future: [] });
    setValidity(contractValidity);
    setSaveError(null);
  }, [baseline, contractValidity]);

  // While clean, mirror the server-provided validity (and pick up a fresh one
  // when the loaded skill is refreshed).
  useEffect(() => {
    if (!dirty) setValidity(contractValidity);
  }, [dirty, contractValidity]);

  // Debounced dry-run validation against the server (the same validator the
  // Save gate uses), so errors surface live while editing. spaceId/auth are in
  // the deps so a space switch re-validates against the right space.
  const seq = useRef(0);
  useEffect(() => {
    if (!dirty) return;
    const id = ++seq.current;
    setValidating(true);
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const h = headers();
          h['X-Space-ID'] = spaceId;
          h['Content-Type'] = 'application/json';
          const res = await authFetch(`${apiUrl}/spaces/${spaceId}/workflows/validate`, {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ workflow: state.present }),
          });
          if (id !== seq.current) return;
          if (res.ok) setValidity((await res.json()) as SkillValidity);
        } catch {
          // Network error or auth redirect; keep last-known validity.
        } finally {
          if (id === seq.current) setValidating(false);
        }
      })();
    }, 350);
    return () => {
      clearTimeout(handle);
    };
  }, [state.present, dirty, spaceId, apiUrl, authFetch, headers]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const h = headers();
      h['X-Space-ID'] = spaceId;
      h['Content-Type'] = 'application/json';
      // The lossless save authority — validates the graph against the skill's
      // real campaign contract (which the plain workflow PUT does not) and
      // leaves the manifest + eval suite untouched.
      const res = await authFetch(`${apiUrl}/spaces/${spaceId}/workflows/${slug}/authoring`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({
          tokens: { workflowRevision: baseline.revision },
          workflow: state.present,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setSaveError(body?.message ?? `Save failed (HTTP ${String(res.status)})`);
        return;
      }
      const result = (await res.json()) as { newRevision: number; contractValidity: SkillValidity };
      const saved = { ...state.present, revision: result.newRevision };
      lastCoalesce.current = null;
      setBaseline(saved);
      setState({ past: [], present: saved, future: [] });
      setValidity(result.contractValidity);
      await queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'workflow', slug] });
    } finally {
      setSaving(false);
    }
  }, [apiUrl, authFetch, headers, spaceId, slug, state.present, baseline.revision, queryClient]);

  return {
    draft: state.present,
    baseline,
    dirty,
    validity,
    validating,
    saving,
    saveError,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    actions,
    undo,
    redo,
    discard,
    save,
  };
}
