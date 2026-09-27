'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CampaignContractField, SkillCampaignContract, SkillGoal } from '@aflow/schemas';

import { useApi } from '../providers.js';

/**
 * Operator draft for a skill's manifest — its goal and campaign contract — with
 * one edit buffer + Save (PUT /authoring, manifest patch). Both live in the same
 * doc under one version token, so they share one draft (editing them as two
 * buffers would make a save of one stale the other). The save is preconditioned
 * on the manifest token from the authoring snapshot; a concurrent change
 * surfaces as a 409. Removing every contract field clears the contract (the
 * skill becomes config-less). The server validates the merged result.
 */
export interface ContractDraftActions {
  addField: () => void;
  renameField: (oldKey: string, newKey: string) => void;
  patchField: (key: string, patch: Partial<CampaignContractField>) => void;
  removeField: (key: string) => void;
}

export interface UseManifestDraft {
  goal: SkillGoal | null;
  contract: SkillCampaignContract | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  setGoal: (goal: SkillGoal) => void;
  contractActions: ContractDraftActions;
  save: () => Promise<void>;
  discard: () => void;
}

interface ManifestDraftState {
  goal: SkillGoal | null;
  campaign: SkillCampaignContract | null;
}

/** Mirrors the server's CAMPAIGN_FIELD_KEY_RE — keys are referenced by `$campaign` refs. */
export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const defaultFieldSchema = (): Record<string, unknown> => ({ type: 'string', minLength: 1 });

const canon = (s: ManifestDraftState): string => JSON.stringify(s);

function freshKey(fields: Record<string, CampaignContractField>): string {
  let n = 1;
  let key = 'field';
  while (Object.prototype.hasOwnProperty.call(fields, key)) {
    n += 1;
    key = `field${String(n)}`;
  }
  return key;
}

export function useManifestDraft({
  goal,
  contract,
  manifestHash,
  spaceId,
  slug,
}: {
  goal: SkillGoal | null;
  contract: SkillCampaignContract | null;
  manifestHash: string | null;
  spaceId: string;
  slug: string;
}): UseManifestDraft {
  const { apiUrl, headers, authFetch } = useApi();
  const queryClient = useQueryClient();
  const baseline = useMemo<ManifestDraftState>(
    () => ({ goal, campaign: contract }),
    [goal, contract],
  );
  const [state, setState] = useState<ManifestDraftState>(baseline);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const syncedToken = useRef<string | null>(manifestHash);
  // Set when a 409 drove the refetch — keep the conflict message visible across
  // the re-sync so the operator sees their edit was dropped, not a silent reset.
  const conflictPending = useRef(false);

  // Re-sync when the token advances (after our own save, or an external change).
  useEffect(() => {
    if (syncedToken.current !== manifestHash) {
      syncedToken.current = manifestHash;
      setState(baseline);
      if (conflictPending.current) conflictPending.current = false;
      else setSaveError(null);
    }
  }, [manifestHash, baseline]);

  const dirty = useMemo(() => canon(state) !== canon(baseline), [state, baseline]);

  const setGoal = useCallback((g: SkillGoal) => {
    setState((s) => ({ ...s, goal: g }));
  }, []);

  const contractActions = useMemo<ContractDraftActions>(
    () => ({
      addField: () => {
        setState((s) => {
          const fields = s.campaign?.fields ?? {};
          const key = freshKey(fields);
          return {
            ...s,
            campaign: {
              fields: { ...fields, [key]: { schema: defaultFieldSchema(), label: 'New field' } },
            },
          };
        });
      },
      renameField: (oldKey, newKey) => {
        setState((s) => {
          const fields = s.campaign?.fields;
          if (
            !fields?.[oldKey] ||
            newKey === oldKey ||
            fields[newKey] ||
            !FIELD_KEY_RE.test(newKey)
          )
            return s;
          const next: Record<string, CampaignContractField> = {};
          for (const [k, v] of Object.entries(fields)) next[k === oldKey ? newKey : k] = v;
          return { ...s, campaign: { fields: next } };
        });
      },
      patchField: (key, patch) => {
        setState((s) => {
          const cur = s.campaign?.fields[key];
          if (!s.campaign || !cur) return s;
          return {
            ...s,
            campaign: { fields: { ...s.campaign.fields, [key]: { ...cur, ...patch } } },
          };
        });
      },
      removeField: (key) => {
        setState((s) => {
          if (!s.campaign) return s;
          const next = { ...s.campaign.fields };
          delete next[key];
          return { ...s, campaign: { fields: next } };
        });
      },
    }),
    [],
  );

  const discard = useCallback(() => {
    setState(baseline);
    setSaveError(null);
  }, [baseline]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const h = headers();
      h['X-Space-ID'] = spaceId;
      h['Content-Type'] = 'application/json';
      // Empty fields ⇒ clear the contract (config-less skill).
      const campaign =
        state.campaign && Object.keys(state.campaign.fields).length > 0 ? state.campaign : null;
      const savedState: ManifestDraftState = { goal: state.goal, campaign };
      const manifest: { goal?: SkillGoal; campaign: SkillCampaignContract | null } = { campaign };
      if (state.goal) manifest.goal = state.goal;
      const res = await authFetch(`${apiUrl}/spaces/${spaceId}/workflows/${slug}/authoring`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ tokens: { manifestHash }, manifest }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setSaveError(body?.message ?? `Save failed (HTTP ${String(res.status)})`);
        // A stale conflict means our token is behind — refetch so the editor
        // shows current truth; the message persists so the dropped edit is clear.
        if (res.status === 409) {
          conflictPending.current = true;
          await queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'workflow', slug] });
        }
        return;
      }
      // Re-baseline locally so the save bar clears even when the manifest token
      // is unchanged (a no-op edit that normalizes back to the saved value).
      setState(savedState);
      await queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'workflow', slug] });
    } finally {
      setSaving(false);
    }
  }, [apiUrl, authFetch, headers, spaceId, slug, manifestHash, state, queryClient]);

  return {
    goal: state.goal,
    contract: state.campaign,
    dirty,
    saving,
    saveError,
    setGoal,
    contractActions,
    save,
    discard,
  };
}
