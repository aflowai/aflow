'use client';

import type { CSSProperties } from 'react';
import {
  Checkbox,
  Column,
  Field,
  HelperText,
  Label,
  Row,
  Select,
  Text,
} from '@aflow/design-system';
import { CLERK_AUTO, CLERK_SPACE_DEFAULT, DEFAULT_CYBERNETIC_MODEL } from '@aflow/schemas';
import type {
  DirectiveModelDefaults,
  DirectiveReasoningDefaults,
  DirectiveReasoningEffort,
} from '@aflow/schemas';
import type { ModelOption } from '../../hooks/useChatModelOptions.js';
import type { ClerkReadiness } from '../../hooks/useSpaceLlmReadiness.js';

export type ModelRole = 'default' | 'helmsman' | 'runner' | 'coach' | 'judge' | 'clerk';

/** The roles that answer to the space default. Clerk resolves its own. */
type InheritingRole = Exclude<ModelRole, 'default' | 'clerk'>;

const EFFORT_LABELS: Record<DirectiveReasoningEffort, string> = {
  off: 'Off (suppress reasoning)',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const OVERRIDE_ROLES: ReadonlyArray<{
  role: InheritingRole;
  label: string;
  hint: string;
}> = [
  {
    role: 'helmsman',
    label: 'Helmsman',
    hint: 'Chats with the operator and drives the session.',
  },
  {
    role: 'runner',
    label: 'Runner',
    hint: 'Per-task workers spawned by workflow procedures.',
  },
  {
    role: 'coach',
    label: 'Coach',
    hint: 'Learning supervisor that reviews completed runs.',
  },
  {
    role: 'judge',
    label: 'Judge',
    hint: 'LLM judge for eval graders. Per-criterion model still wins.',
  },
];

/**
 * Apply one role's model choice to a directives draft.
 *
 * Shared by the settings page and the in-composer popover: both edit the same
 * space setting, and two copies of this is how they came to disagree about
 * what an empty value means for a role.
 */
export function applyModelRoleChange(
  defaults: DirectiveModelDefaults,
  role: ModelRole,
  value: string | undefined,
): DirectiveModelDefaults {
  const next = { ...defaults };
  if (role === 'default') {
    next.default = value && value.length > 0 ? value : DEFAULT_CYBERNETIC_MODEL;
    return next;
  }
  // `auto` is the Clerk's unset state, so storing it would record a choice
  // where none was made — and a space that later follows a changed platform
  // recommendation would be pinned to the spelling of the old one.
  if (role === 'clerk' && (value === undefined || value === CLERK_AUTO)) {
    delete next.clerk;
    return next;
  }
  if (value && value.length > 0) next[role] = value;
  else delete next[role];
  return next;
}

export function applyReasoningRoleChange(
  defaults: DirectiveReasoningDefaults | undefined,
  role: ModelRole,
  value: DirectiveReasoningEffort | undefined,
): DirectiveReasoningDefaults {
  const next = { ...(defaults ?? {}) };
  if (value === undefined) delete next[role];
  else next[role] = value;
  return next;
}

interface ModelDefaultsEditorProps {
  modelDefaults: DirectiveModelDefaults;
  reasoningDefaults: DirectiveReasoningDefaults | undefined;
  modelOptions: ModelOption[];
  /** What the Clerk may be assigned explicitly. Falls back to `modelOptions`. */
  clerkModelOptions?: ModelOption[];
  /** What the Clerk currently resolves to, for the `Auto` row's subtitle. */
  clerkReadiness?: ClerkReadiness | null;
  /** Whether this space summarizes its conversations. Omit to hide the control. */
  conversationSummaries?: boolean | undefined;
  onConversationSummariesChange?: (next: boolean) => void;
  loading: boolean;
  error: string | null;
  onModelChange: (role: ModelRole, value: string | undefined) => void;
  onReasoningChange: (role: ModelRole, value: DirectiveReasoningEffort | undefined) => void;
  /**
   * `page` — every role expanded with full helper text (the settings tab).
   * `compact` — the space default is always visible; per-role overrides tuck
   * into a collapsed disclosure (the in-composer quick-settings popover).
   */
  variant?: 'page' | 'compact';
  /** Label style applied in the `page` variant (e.g. the settings accent). */
  labelStyle?: CSSProperties;
  disabled?: boolean;
  /** Credential provider missing a key for this model ref, or null when ready. */
  missingProviderForRef?: (ref: string) => string | null;
  /** Opens key entry for a provider surfaced by `missingProviderForRef`. */
  onConnectProvider?: (providerId: string) => void;
}

/**
 * Single source of truth for the per-role model + reasoning-effort editor.
 * The space-wide `default` applies to every cybernetic role unless that role
 * carries its own override; clearing an override falls back to the default.
 */
export function ModelDefaultsEditor({
  modelDefaults,
  reasoningDefaults,
  modelOptions,
  clerkModelOptions,
  clerkReadiness,
  conversationSummaries,
  onConversationSummariesChange,
  loading,
  error,
  onModelChange,
  onReasoningChange,
  variant = 'page',
  labelStyle: pageLabelStyle,
  disabled = false,
  missingProviderForRef,
  onConnectProvider,
}: ModelDefaultsEditorProps) {
  if (loading) {
    return <Text variant="muted">Loading models…</Text>;
  }
  if (error) {
    return <Text variant="muted">Failed to load models: {error}</Text>;
  }

  const compact = variant === 'compact';

  // Options are keyed by the model's durable ref, so a saved assignment follows
  // the tier rather than pinning the version behind it. Every spelling a space
  // can be holding reaches here from storage — id, alias, or an id that retired
  // into this model — and all of them normalize to that one value, so the
  // select never renders blank for a model it is perfectly able to show, and
  // saving rewrites a retired ref to the durable one.
  const optionValueForRef = (ref: string): string => {
    if (!ref) return '';
    const match = modelOptions.find(
      (o) => o.id === ref || o.aliases.includes(ref) || o.retiredRefs.includes(ref),
    );
    return match ? match.ref : ref;
  };

  const renderModelSelect = (role: ModelRole, isOverride: boolean) => {
    const placeholder = isOverride ? `Use default (${modelDefaults.default})` : 'Select a model';
    const effectiveRef = modelDefaults[role] ?? (isOverride ? modelDefaults.default : '');
    const missingProvider =
      effectiveRef && missingProviderForRef ? missingProviderForRef(effectiveRef) : null;
    return (
      <>
        <Select
          value={optionValueForRef(modelDefaults[role] ?? '')}
          disabled={disabled}
          onChange={(e) => {
            onModelChange(role, e.target.value || undefined);
          }}
        >
          {isOverride ? <option value="">{placeholder}</option> : null}
          {modelOptions.map((opt) => {
            // A model the tenant no longer permits is listed only to show what
            // a role already runs, so it stays selectable on that role alone —
            // offering it to the others would be a new assignment, which is
            // exactly what narrowing the set blocks.
            const isCurrentForRole = optionValueForRef(modelDefaults[role] ?? '') === opt.ref;
            return (
              <option key={opt.id} value={opt.ref} disabled={!opt.allowed && !isCurrentForRole}>
                {opt.displayName}
                {opt.aliases.length > 0 ? ` (${opt.aliases[0]})` : ''}
                {opt.allowed ? '' : ' — no longer permitted'}
              </option>
            );
          })}
        </Select>
        {missingProvider && (
          <button
            type="button"
            onClick={() => onConnectProvider?.(missingProvider)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              marginTop: 'var(--space-1)',
              padding: '2px var(--space-2)',
              borderRadius: 'var(--radius-full, 999px)',
              border: '1px solid var(--color-border-default)',
              background: 'var(--color-surface-2)',
              color: 'var(--color-text-secondary)',
              fontSize: 'var(--font-size-xs)',
              cursor: 'pointer',
            }}
          >
            Needs key — connect
          </button>
        )}
      </>
    );
  };

  // Reasoning effort layers on top of the resolved model, so the rungs offered
  // follow that model — some tiers refuse the lowest, and a model with no
  // reasoning control offers none at all. Offering a rung outside this set
  // would not fail the run: the client clamps it to a supported one. It would
  // just quietly run at an effort the operator never chose.
  const supportedEffortsFor = (role: ModelRole): DirectiveReasoningEffort[] => {
    const ref = modelDefaults[role] ?? modelDefaults.default;
    const model = modelOptions.find(
      (o) => o.id === ref || o.aliases.includes(ref) || o.retiredRefs.includes(ref),
    );
    return model?.reasoningEfforts ?? [];
  };

  const renderReasoningSelect = (role: ModelRole) => {
    const supported = supportedEffortsFor(role);
    const selected = reasoningDefaults?.[role];
    // Unset means the catalog's default for every role except the Clerk,
    // whose unset value is `off` — saying "catalog default" there would
    // describe an effort the runtime does not use.
    const unsetLabel =
      supported.length === 0
        ? 'No reasoning control'
        : role === 'clerk'
          ? 'Off'
          : 'Catalog default';
    // A stored value the resolved model rejects stays visible and flagged
    // rather than rendering as "Catalog default" — including when the model
    // takes no reasoning config at all, where hiding it would leave the
    // operator with a saved setting they can neither see nor clear.
    const stale = selected && !supported.includes(selected) ? selected : undefined;

    if (supported.length === 0 && !stale) {
      return (
        <Select value="" disabled>
          <option value="">No reasoning control</option>
        </Select>
      );
    }

    return (
      <Select
        value={selected ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onReasoningChange(role, v === '' ? undefined : (v as DirectiveReasoningEffort));
        }}
      >
        <option value="">{unsetLabel}</option>
        {supported.map((effort) => (
          <option key={effort} value={effort}>
            {EFFORT_LABELS[effort]}
          </option>
        ))}
        {stale ? <option value={stale}>{EFFORT_LABELS[stale]} — unsupported</option> : null}
      </Select>
    );
  };

  const renderRoleRow = (role: ModelRole, isOverride: boolean) => (
    <Row gap="2" align="start" style={{ flexWrap: 'wrap' }}>
      <div style={{ flex: '2 1 200px', minWidth: 0 }}>{renderModelSelect(role, isOverride)}</div>
      <div style={{ flex: '1 1 140px', minWidth: 0 }}>{renderReasoningSelect(role)}</div>
    </Row>
  );

  const labelStyle: CSSProperties = compact
    ? { display: 'block', marginBottom: 'var(--space-1)', fontSize: 'var(--font-size-xs)' }
    : { display: 'block', marginBottom: 'var(--space-1)', ...pageLabelStyle };

  const defaultRow = (
    <Field>
      <Label style={labelStyle}>
        {compact ? 'Default model' : 'Space default — model & reasoning'}
      </Label>
      {renderRoleRow('default', false)}
      <HelperText>
        Applies to Helmsman, Runner, Coach and Judge unless overridden below. The Clerk resolves its
        own.
      </HelperText>
    </Field>
  );

  // The Clerk's row is not an override row. Every other role falls back to the
  // space default and its empty value says so; the Clerk's empty value means
  // `auto`, and rendering "Use default (glm-pro)" over it would describe the
  // opposite of what leaving it alone does.
  const clerkOptions = clerkModelOptions ?? modelOptions;
  const clerkStored = modelDefaults.clerk;
  const clerkSelectValue =
    clerkStored === undefined || clerkStored === CLERK_AUTO
      ? CLERK_AUTO
      : clerkStored === CLERK_SPACE_DEFAULT
        ? CLERK_SPACE_DEFAULT
        : optionValueForRef(clerkStored);

  const clerkAutoLabel = (() => {
    if (clerkReadiness?.mode !== 'auto') return 'Auto · small model';
    if (clerkReadiness.model) return `Auto · small model — ${clerkReadiness.model}`;
    return 'Auto · small model — none available';
  })();

  const clerkNote = (() => {
    if (clerkStored !== undefined && clerkStored !== CLERK_AUTO) return null;
    const reason = clerkReadiness?.unavailableReason;
    if (reason === 'not_permitted') {
      return 'No model your organization permits is suitable for background summaries on this provider. Permit one, or pick a model here.';
    }
    if (reason === 'no_candidate_for_provider') {
      return 'No economical model is available for the space default’s provider. Pick a model here instead.';
    }
    if (reason === 'unknown_model') {
      return 'The assigned model is no longer in the catalog. Pick another.';
    }
    if (clerkReadiness && !clerkReadiness.credentialResolved) {
      return 'No key resolves for this model yet. Conversations keep plain names until one does.';
    }
    return null;
  })();

  const clerkRow = (
    <Field>
      <Label style={labelStyle}>Clerk</Label>
      <Row gap="2" align="start" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 200px', minWidth: 0 }}>
          <Select
            value={clerkSelectValue}
            disabled={disabled}
            onChange={(e) => {
              onModelChange('clerk', e.target.value);
            }}
          >
            <option value={CLERK_AUTO}>{clerkAutoLabel}</option>
            <option value={CLERK_SPACE_DEFAULT}>Use space default ({modelDefaults.default})</option>
            {clerkOptions.map((opt) => (
              <option key={opt.id} value={opt.ref} disabled={!opt.allowed}>
                {opt.displayName}
                {opt.aliases.length > 0 ? ` (${opt.aliases[0]})` : ''}
                {opt.allowed ? '' : ' — no longer permitted'}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>{renderReasoningSelect('clerk')}</div>
      </Row>
      {clerkNote ? <HelperText>{clerkNote}</HelperText> : null}
      <HelperText>Background summaries, synthesis, and metadata upkeep.</HelperText>
      {conversationSummaries !== undefined && onConversationSummariesChange ? (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Checkbox
            checked={conversationSummaries}
            disabled={disabled}
            onChange={(e) => {
              onConversationSummariesChange(e.target.checked);
            }}
            label="Summarize conversations"
          />
          <HelperText>
            Rewrites a one-line synopsis under each conversation&rsquo;s name every time the agent
            replies, so it is current whenever you are reading it. Names are generated either way.
          </HelperText>
        </div>
      ) : null}
    </Field>
  );

  if (compact) {
    return (
      <Column gap="sm">
        {defaultRow}
        <details>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-secondary)',
              fontWeight: 600,
              padding: 'var(--space-1) 0',
            }}
          >
            Per-role overrides
          </summary>
          <Column gap="sm" style={{ marginTop: 'var(--space-2)' }}>
            {OVERRIDE_ROLES.map(({ role, label }) => (
              <Field key={role}>
                <Label style={labelStyle}>{label}</Label>
                {renderRoleRow(role, true)}
              </Field>
            ))}
            {clerkRow}
          </Column>
        </details>
      </Column>
    );
  }

  return (
    <>
      {defaultRow}
      {OVERRIDE_ROLES.map(({ role, label, hint }) => (
        <Field key={role}>
          <Label style={labelStyle}>{label} override</Label>
          {renderRoleRow(role, true)}
          <HelperText>{hint} Leave both empty to use the space default.</HelperText>
        </Field>
      ))}
      {clerkRow}
    </>
  );
}
