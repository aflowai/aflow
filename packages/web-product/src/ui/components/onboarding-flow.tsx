'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, Checkbox, Icon, Input } from '@aflow/design-system';
import {
  RECOMMENDED_AGENT_MODELS,
  type RecommendedAgentModel,
  type AgentModelProviderId,
} from '@aflow/schemas';
import { CreateSpaceForm, type CreateSpaceResult } from './create-space-form.js';
import { useApi, useSpace } from './providers.js';
import { useChatModelOptions } from '../hooks/useChatModelOptions.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { deferProviderSetup } from './provider-setup-deferral.js';

// =============================================================================
// Constants
// =============================================================================

const SUGGESTED_PROMPTS = ['What can you do?', 'Help me set up my first process'];

const AGENT_ROLES = ['helmsman', 'runner', 'coach', 'judge'] as const;
type AgentRole = (typeof AGENT_ROLES)[number];

const ROLE_LABELS: Record<AgentRole, string> = {
  helmsman: 'Helmsman (chat & planning)',
  runner: 'Runner (task work)',
  coach: 'Coach (learning)',
  judge: 'Judge (evaluation)',
};

// =============================================================================
// Styles
// =============================================================================

const containerStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--space-6)',
};

const cardStyle: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  position: 'relative' as const,
  padding: 'var(--space-2xl)',
  backgroundColor: 'var(--color-surface-0)',
  borderRadius: 'var(--radius-2xl)',
};

const fadeKeyframes = `
  @keyframes onb-fade-slide {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

// =============================================================================
// Small building blocks
// =============================================================================

function FadeSlide({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        opacity: 0,
        animation: `onb-fade-slide 0.5s var(--transition-timing-ease-out) ${delay}s forwards`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background:
              i === current ? 'var(--color-interactive-default)' : 'var(--color-border-default)',
            transition: 'background 200ms',
          }}
        />
      ))}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        marginBottom: 'var(--space-4)',
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-muted)',
      }}
    >
      <Icon name="arrow-left" size="sm" />
      Back
    </button>
  );
}

function StepHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      style={{
        margin: '0 0 var(--space-2)',
        fontSize: 'var(--font-size-xl)',
        fontFamily: 'var(--font-family-title)',
        fontWeight: 600,
        color: 'var(--color-text-primary)',
      }}
    >
      {children}
    </h2>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-status-failed)',
        background: 'var(--color-status-failed-bg)',
        color: 'var(--color-status-failed)',
        fontSize: 'var(--font-size-sm)',
        marginBottom: 'var(--space-3)',
      }}
    >
      <Icon name="warning-circle" size="sm" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{children}</span>
    </div>
  );
}

function StepLede({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: '0 0 var(--space-5)',
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-secondary)',
        lineHeight: 1.6,
      }}
    >
      {children}
    </p>
  );
}

// =============================================================================
// Step 1 — Welcome
// =============================================================================

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <FadeSlide delay={0.1}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 5 7"
          width={44}
          height={44 * (7 / 5)}
          shapeRendering="crispEdges"
          aria-hidden
          style={{
            transform: 'rotate(-10deg)',
            transformOrigin: 'center',
            margin: '0 auto var(--space-5)',
            display: 'block',
          }}
        >
          <rect fill="#6B6B6B" x="0" y="0" width="1" height="1" />
          <rect fill="#6B6B6B" x="4" y="0" width="1" height="1" />
          <rect fill="#E8384F" x="0" y="2" width="5" height="1" />
          <rect fill="#C42D3E" x="0" y="3" width="5" height="1" />
          <rect fill="#E8384F" x="0" y="4" width="5" height="1" />
          <rect fill="#C42D3E" x="1" y="5" width="3" height="2" />
          <rect fill="#8A8A8A" x="1" y="1" width="3" height="1" />
        </svg>
      </FadeSlide>

      <FadeSlide delay={0.25}>
        <h1
          style={{
            margin: 0,
            fontSize: 'var(--font-size-2xl)',
            fontFamily: 'var(--font-family-title)',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            marginBottom: 'var(--space-3)',
          }}
        >
          Welcome to Aflow
        </h1>
      </FadeSlide>

      <FadeSlide delay={0.4}>
        <p
          style={{
            margin: '0 auto var(--space-6)',
            maxWidth: 400,
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
          }}
        >
          Three quick steps: create your workspace, pick the AI model it runs on, and connect your
          key. Your agents handle tasks, learn from experience, and get better over time.
        </p>
      </FadeSlide>

      <FadeSlide delay={0.55}>
        <Button variant="primary" size="lg" onClick={onNext}>
          Create your workspace
        </Button>
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Step 2 — Workspace
// =============================================================================

function StepWorkspace({
  onCreated,
  onBack,
}: {
  onCreated: (space: CreateSpaceResult) => void;
  onBack: () => void;
}) {
  return (
    <div>
      <FadeSlide>
        <BackButton onClick={onBack} />
      </FadeSlide>
      <FadeSlide delay={0.05}>
        <StepHeading>Set up your workspace</StepHeading>
        <StepLede>Name it after the work it will own — you can create more later.</StepLede>
      </FadeSlide>
      <FadeSlide delay={0.1}>
        <CreateSpaceForm onCreated={onCreated} autoFocus submitLabel="Continue" />
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Step 2 (resumed) — Name the workspace bootstrap already made
// =============================================================================

/**
 * A resumed flow starts on a workspace the operator did not create and did not
 * name — bootstrap claims the one the tenant schema seeds, which arrives called
 * "General". Offering the name here is the step the full flow spends on
 * `CreateSpaceForm`, minus the creating.
 *
 * The slug is left alone. Settings treats name and slug as separately editable,
 * and the slug is the URL this workspace answers on.
 */
function StepNameWorkspace({
  space,
  onDone,
}: {
  space: CreateSpaceResult;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string | null>(null);

  // Through the shared mutation path, so the rename invalidates the caches the
  // shell reads the workspace's name from. A direct fetch here would leave the
  // switcher and the settings page showing the name the operator just changed.
  const rename = useApiMutation<{ name: string }>({
    path: `/spaces/${space.id}`,
    method: 'PATCH',
    spaceId: space.id,
    invalidate: [['spaces'], ['space', space.id]],
  });

  const trimmed = name.trim();
  const saving = rename.isPending;

  const save = () => {
    if (trimmed === '') return;
    if (trimmed === space.name) {
      onDone(space.name);
      return;
    }
    setError(null);
    rename.mutate(
      { name: trimmed },
      {
        onSuccess: () => {
          onDone(trimmed);
        },
        onError: (err) => {
          setError(err.message);
        },
      },
    );
  };

  return (
    <div>
      <FadeSlide delay={0.05}>
        <StepHeading>Name your workspace</StepHeading>
        <StepLede>
          This one was made for you when the instance started. Name it after the work it will own —
          you can create more later.
        </StepLede>
      </FadeSlide>
      <FadeSlide delay={0.1}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          autoFocus
          disabled={saving}
          aria-label="Workspace name"
        />
        {error !== null && (
          <div
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-danger)',
            }}
          >
            {error}
          </div>
        )}
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Button
            onClick={() => {
              save();
            }}
            disabled={saving || trimmed === ''}
          >
            {saving ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Step 3 — Model
// =============================================================================

function ModelCard({
  model,
  selected,
  onSelect,
}: {
  model: RecommendedAgentModel;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: '2px solid',
        borderColor: selected ? 'var(--color-interactive-default)' : 'var(--color-border-subtle)',
        background: selected ? 'var(--color-surface-1)' : 'transparent',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-1)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>{model.label}</span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          via {providerDisplayName(model.credentialProviderId)}
        </span>
        {model.recommended && (
          <Badge variant="accent" style={{ fontSize: 'var(--font-size-xs)' }}>
            Recommended
          </Badge>
        )}
      </div>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
        }}
      >
        {model.tagline}
      </div>
    </div>
  );
}

function providerDisplayName(providerId: AgentModelProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'openai':
      return 'OpenAI';
    case 'fireworks':
      return 'Fireworks AI';
    case 'xai':
      return 'xAI';
  }
}

export interface ModelSelection {
  defaultRef: string;
  roleOverrides: Partial<Record<AgentRole, string>>;
}

/** Unique credential providers implied by a model selection. */
function providersForSelection(selection: ModelSelection): AgentModelProviderId[] {
  const refs = [selection.defaultRef, ...Object.values(selection.roleOverrides)];
  const providers = new Set<AgentModelProviderId>();
  for (const ref of refs) {
    const entry = RECOMMENDED_AGENT_MODELS.find((m) => m.modelId === ref || m.alias === ref);
    if (entry) providers.add(entry.credentialProviderId);
  }
  return [...providers];
}

function modelRef(model: RecommendedAgentModel): string {
  return model.alias ?? model.modelId;
}

/**
 * The model choice a workspace already holds.
 *
 * A resumed flow opens on a workspace that has been configured, and the model
 * step writes the whole `modelDefaults` object back — so starting from the
 * recommendation would replace the operator's current default and delete every
 * role override the moment they pressed Continue, without showing them either.
 * A ref outside the recommendation set is kept as it is: the workspace is
 * running on it.
 */
export function selectionFromDirectives(
  directives: Record<string, unknown> | null,
): ModelSelection {
  const held = (directives ?? {}) as { modelDefaults?: Record<string, unknown> };
  const defaults = (held.modelDefaults ?? {}) as { default?: unknown } & Record<string, unknown>;

  const roleOverrides: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLES) {
    const ref = defaults[role];
    if (typeof ref === 'string' && ref !== '') roleOverrides[role] = ref;
  }

  return {
    defaultRef: typeof defaults.default === 'string' ? defaults.default : '',
    roleOverrides,
  };
}

function StepModel({
  space,
  initial,
  onDone,
}: {
  space: CreateSpaceResult;
  /** Re-entry (Back from the connect step) restores the saved selection. */
  initial: ModelSelection | null;
  onDone: (selection: ModelSelection) => void;
}) {
  const { headers, authFetch } = useApi();
  // Only models this tenant permits: offering one it excludes would fail the
  // save the step exists to perform. A tenant whose set excludes every
  // recommended model gets none of these cards and keeps the model the space
  // was created with.
  const { modelOptions, modelOptionsLoading, modelOptionsError } = useChatModelOptions();
  const offered = useMemo(() => {
    const allowed = new Set(modelOptions.flatMap((o) => [o.id, ...o.aliases]));
    return RECOMMENDED_AGENT_MODELS.filter(
      (m) => allowed.has(m.modelId) || (m.alias !== undefined && allowed.has(m.alias)),
    );
  }, [modelOptions]);
  const defaultEntry = offered.find((m) => m.recommended) ?? offered[0];
  // The policy has not loaded on first render, so the selection is seeded once
  // it arrives rather than by the state initializer, which would freeze a
  // choice made from an empty list.
  // Back re-entry restores what was chosen; otherwise the workspace's own
  // defaults, which a resumed flow must not silently overwrite.
  const existing = useMemo(() => selectionFromDirectives(space.directives), [space.directives]);
  // The same model reaches a stored default as either its catalogue id or its
  // alias, while a card is keyed by one of them — so a held default has to be
  // matched on both or the step renders with nothing selected while holding a
  // perfectly good choice.
  const heldDefault = useMemo(() => {
    if (existing.defaultRef === '') return '';
    const match = offered.find(
      (m) => m.modelId === existing.defaultRef || m.alias === existing.defaultRef,
    );
    return match ? modelRef(match) : existing.defaultRef;
  }, [existing.defaultRef, offered]);
  const [defaultRef, setDefaultRef] = useState<string>(initial?.defaultRef ?? '');
  // One seeding decision, made once the offered list arrives — neither source
  // can be matched against an empty list. What the workspace already runs on
  // wins over the recommendation, which is only a suggestion for a workspace
  // that has not chosen yet.
  useEffect(() => {
    if (defaultRef !== '') return;
    if (heldDefault !== '') {
      setDefaultRef(heldDefault);
      return;
    }
    if (defaultEntry) setDefaultRef(modelRef(defaultEntry));
  }, [defaultRef, heldDefault, defaultEntry]);

  const [roleOverrides, setRoleOverrides] = useState<Partial<Record<AgentRole, string>>>(
    initial?.roleOverrides ?? existing.roleOverrides,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    // Nothing to save when no model was offered or chosen: the space keeps
    // whatever creation assigned it, which the server already held to the
    // tenant's set.
    if (defaultRef === '') {
      onDone({ defaultRef: '', roleOverrides: {} });
      return;
    }
    setSaving(true);
    setError(null);
    const selection: ModelSelection = { defaultRef, roleOverrides };
    try {
      const baseDirectives = space.directives ?? {
        version: 1,
        responsibility: 'General-purpose workspace.',
      };
      const modelDefaults: Record<string, string> = { default: defaultRef };
      for (const role of AGENT_ROLES) {
        const override = roleOverrides[role];
        if (override && override !== defaultRef) modelDefaults[role] = override;
      }
      // No active space exists during onboarding, so headers() carries no
      // X-Space-ID — the PATCH handler's requireSpace() needs it explicitly.
      const res = await authFetch(`/api/spaces/${space.id}`, {
        method: 'PATCH',
        headers: { ...headers(), 'X-Space-ID': space.id },
        body: JSON.stringify({ directives: { ...baseDirectives, modelDefaults } }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Could not save the model choice (${res.status})`);
        setSaving(false);
        return;
      }
      onDone(selection);
    } catch {
      setError('Network error — please try again.');
      setSaving(false);
    }
  };

  return (
    <div>
      <FadeSlide delay={0.05}>
        <StepHeading>Choose your model</StepHeading>
        <StepLede>
          The model your agents think with. You bring your own key — model usage is billed by the
          provider, not by Aflow. You can change this anytime.
        </StepLede>
      </FadeSlide>

      <FadeSlide delay={0.1}>
        <div
          role="radiogroup"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-4)',
          }}
        >
          {modelOptionsLoading ? (
            <StepLede>Loading the models available to you…</StepLede>
          ) : modelOptionsError ? (
            // Falling back to the full recommended list would offer models the
            // tenant may not permit, and every pick would fail on save.
            <StepLede>
              Could not load the available models ({modelOptionsError}). Continue — your workspace
              keeps the model it was created with, and you can change it in settings.
            </StepLede>
          ) : offered.length === 0 ? (
            <StepLede>
              Your administrator has chosen a custom set of models. Continue — your workspace keeps
              the model it was created with, and you can change it in settings.
            </StepLede>
          ) : (
            offered.map((model) => (
              <ModelCard
                key={model.modelId}
                model={model}
                selected={defaultRef === modelRef(model)}
                onSelect={() => {
                  setDefaultRef(modelRef(model));
                }}
              />
            ))
          )}
        </div>
      </FadeSlide>

      <FadeSlide delay={0.15}>
        <details style={{ marginBottom: 'var(--space-4)' }}>
          <summary
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            Advanced: choose per agent role
          </summary>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-3)',
            }}
          >
            {AGENT_ROLES.map((role) => (
              <label
                key={role}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <span style={{ flex: 1 }}>{ROLE_LABELS[role]}</span>
                <select
                  value={roleOverrides[role] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRoleOverrides((prev) => {
                      const next = { ...prev };
                      if (value) next[role] = value;
                      else delete next[role];
                      return next;
                    });
                  }}
                  style={{
                    padding: 'var(--space-1) var(--space-2)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border-default)',
                    background: 'var(--color-surface-0)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-xs)',
                  }}
                >
                  <option value="">Use workspace default</option>
                  {offered.map((model) => (
                    <option key={model.modelId} value={modelRef(model)}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </details>
      </FadeSlide>

      {error && <ErrorNote>{error}</ErrorNote>}

      <FadeSlide delay={0.2}>
        <Button
          variant="primary"
          size="lg"
          loading={saving}
          onClick={() => {
            void handleContinue();
          }}
          style={{ width: '100%' }}
        >
          Continue
        </Button>
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Step 4 — Connect provider key(s)
// =============================================================================

interface ProviderFieldMeta {
  displayName: string;
  placeholder: string;
  helpText: string;
  docsUrl: string | null;
}

const PROVIDER_FALLBACK_META: Record<AgentModelProviderId, ProviderFieldMeta> = {
  anthropic: {
    displayName: 'Anthropic',
    placeholder: 'sk-ant-...',
    helpText: 'Your Anthropic API key.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  google: {
    displayName: 'Google',
    placeholder: 'AIza...',
    helpText: 'Your Google AI Studio API key.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  openai: {
    displayName: 'OpenAI',
    placeholder: 'sk-...',
    helpText: 'Your OpenAI API key.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  fireworks: {
    displayName: 'Fireworks AI',
    placeholder: 'fw_...',
    helpText: 'Your Fireworks API key.',
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
  xai: {
    displayName: 'xAI',
    placeholder: 'xai-...',
    helpText: 'Your xAI API key.',
    docsUrl: 'https://console.x.ai',
  },
};

type ProviderConnectState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'verified' }
  /** Already resolvable via an existing key (e.g. a tenant default). */
  | { phase: 'covered'; coveredBy: 'user' | 'space' | 'tenant' }
  | { phase: 'failed'; message: string };

function coveredByLabel(scope: 'user' | 'space' | 'tenant'): string {
  switch (scope) {
    case 'user':
      return 'your personal key';
    case 'space':
      return 'a workspace key';
    case 'tenant':
      return 'a tenant default key';
  }
}

function StepConnect({
  space,
  providers,
  onDone,
  onSkip,
  onBack,
}: {
  space: CreateSpaceResult;
  providers: AgentModelProviderId[];
  onDone: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const { headers, authFetch } = useApi();
  const [meta, setMeta] = useState<Partial<Record<AgentModelProviderId, ProviderFieldMeta>>>({});
  const [keys, setKeys] = useState<Partial<Record<AgentModelProviderId, string>>>({});
  const [states, setStates] = useState<Partial<Record<AgentModelProviderId, ProviderConnectState>>>(
    {},
  );
  const [spaceOnly, setSpaceOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/credentials/providers', { headers: headers() });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as {
          providers: Array<{
            providerId: string;
            displayName: string;
            docsUrl?: string;
            fields: Array<{ fieldId: string; placeholder?: string; helpText?: string }>;
          }>;
        };
        const next: Partial<Record<AgentModelProviderId, ProviderFieldMeta>> = {};
        for (const p of providers) {
          const def = json.providers.find((d) => d.providerId === p);
          const keyField = def?.fields.find((f) => f.fieldId === 'api_key');
          if (def) {
            next[p] = {
              displayName: def.displayName,
              placeholder: keyField?.placeholder ?? PROVIDER_FALLBACK_META[p].placeholder,
              helpText: keyField?.helpText ?? PROVIDER_FALLBACK_META[p].helpText,
              docsUrl: def.docsUrl ?? null,
            };
          }
        }
        if (!cancelled) setMeta(next);
      } catch {
        // Fallback meta covers the display; keys can still be saved.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, headers, providers]);

  // Providers may already resolve through an existing key (a tenant default,
  // or a personal key from an earlier workspace) — surface that instead of
  // asking for a key that is not needed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`/api/spaces/${space.id}/llm-readiness`, {
          headers: { ...headers(), 'X-Space-ID': space.id },
        });
        if (!res.ok || cancelled) return;
        const readiness = (await res.json()) as {
          roles: Record<
            string,
            {
              providerId: string | null;
              resolved: boolean;
              resolvedScope: 'user' | 'space' | 'tenant' | null;
              status: 'active' | 'error' | null;
              verified: boolean | null;
            }
          >;
        };
        if (cancelled) return;
        setStates((prev) => {
          const next = { ...prev };
          for (const provider of providers) {
            if (next[provider] && next[provider].phase !== 'idle') continue;
            // `verified === false` is a key nothing has tried, which is the
            // state that opens this flow in the first place. Treating it as
            // covered would let Continue mark the step connected, skip the
            // deferral, and reopen the wizard on the reload that follows.
            const role = Object.values(readiness.roles).find(
              (r) =>
                r.providerId === provider &&
                r.resolved &&
                r.status !== 'error' &&
                r.verified !== false,
            );
            if (role?.resolvedScope) {
              next[provider] = { phase: 'covered', coveredBy: role.resolvedScope };
            }
          }
          return next;
        });
      } catch {
        // Readiness probe is best-effort — without it the step just asks for keys.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, headers, providers, space.id]);

  const scope = spaceOnly ? 'space' : 'user';
  const scopedHeaders = () =>
    spaceOnly ? { ...headers(), 'X-Space-ID': space.id } : { ...headers() };

  const connectProvider = async (provider: AgentModelProviderId) => {
    const key = keys[provider]?.trim();
    if (!key) return;
    setStates((prev) => ({ ...prev, [provider]: { phase: 'saving' } }));
    try {
      const putRes = await authFetch(`/api/credentials/${provider}`, {
        method: 'PUT',
        headers: scopedHeaders(),
        body: JSON.stringify({ scope, secrets: { api_key: key } }),
      });
      if (!putRes.ok) {
        const body = (await putRes.json().catch(() => null)) as { error?: string } | null;
        setStates((prev) => ({
          ...prev,
          [provider]: { phase: 'failed', message: body?.error ?? 'Could not save the key.' },
        }));
        return;
      }
      const valRes = await authFetch(`/api/credentials/${provider}/validate`, {
        method: 'POST',
        headers: scopedHeaders(),
        body: JSON.stringify({ scope }),
      });
      const outcome = (await valRes.json().catch(() => null)) as {
        verified?: boolean;
        message?: string | null;
      } | null;
      if (valRes.ok && outcome?.verified) {
        setStates((prev) => ({ ...prev, [provider]: { phase: 'verified' } }));
      } else {
        setStates((prev) => ({
          ...prev,
          [provider]: {
            phase: 'failed',
            message:
              outcome?.message ??
              'The key was saved but could not be verified. You can continue and fix it later.',
          },
        }));
      }
    } catch {
      setStates((prev) => ({
        ...prev,
        [provider]: { phase: 'failed', message: 'Network error — please try again.' },
      }));
    }
  };

  const allDone = providers.every(
    (p) => states[p]?.phase === 'verified' || states[p]?.phase === 'covered',
  );

  return (
    <div>
      <FadeSlide>
        <BackButton onClick={onBack} />
      </FadeSlide>
      <FadeSlide delay={0.05}>
        <StepHeading>Connect your {providers.length > 1 ? 'providers' : 'provider'}</StepHeading>
        <StepLede>
          Your key is stored encrypted and only used to run your agents. Model usage is billed to
          your provider account.
        </StepLede>
      </FadeSlide>

      <FadeSlide delay={0.1}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-4)',
          }}
        >
          {providers.map((provider) => {
            const m = meta[provider] ?? PROVIDER_FALLBACK_META[provider];
            const state = states[provider] ?? { phase: 'idle' };
            return (
              <div
                key={provider}
                style={{
                  padding: 'var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  background: 'var(--color-surface-1)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>
                    {m.displayName} API key
                  </span>
                  {state.phase === 'verified' && (
                    <Badge variant="success" style={{ fontSize: 'var(--font-size-xs)' }}>
                      Verified
                    </Badge>
                  )}
                  {state.phase === 'covered' && (
                    <Badge variant="success" style={{ fontSize: 'var(--font-size-xs)' }}>
                      Already covered
                    </Badge>
                  )}
                  {state.phase !== 'covered' && m.docsUrl && (
                    <a
                      href={m.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        marginLeft: 'auto',
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-content-link)',
                      }}
                    >
                      Where do I get this?
                    </a>
                  )}
                </div>
                {state.phase === 'covered' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      Already resolves through {coveredByLabel(state.coveredBy)} — nothing to
                      connect.
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setStates((prev) => ({ ...prev, [provider]: { phase: 'idle' } }));
                      }}
                    >
                      Use my own key
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Input
                      type="password"
                      placeholder={m.placeholder}
                      value={keys[provider] ?? ''}
                      onChange={(e) => {
                        const value = (e.target as HTMLInputElement).value;
                        setKeys((prev) => ({ ...prev, [provider]: value }));
                        setStates((prev) => ({ ...prev, [provider]: { phase: 'idle' } }));
                      }}
                      style={{ flex: 1 }}
                    />
                    <Button
                      variant="secondary"
                      size="md"
                      loading={state.phase === 'saving'}
                      disabled={!keys[provider]?.trim() || state.phase === 'verified'}
                      onClick={() => {
                        void connectProvider(provider);
                      }}
                    >
                      {state.phase === 'verified' ? 'Connected' : 'Save & test'}
                    </Button>
                  </div>
                )}
                {state.phase === 'failed' && (
                  <div
                    role="alert"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-1)',
                      marginTop: 'var(--space-2)',
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--color-status-failed)',
                    }}
                  >
                    <Icon name="warning-circle" size="xs" style={{ flexShrink: 0 }} />
                    {state.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </FadeSlide>

      <FadeSlide delay={0.15}>
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Checkbox
            size="sm"
            checked={spaceOnly}
            onChange={(e) => {
              setSpaceOnly(e.target.checked);
            }}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>
              Store for this workspace only (default: your keys work across all your workspaces)
            </span>
          </Checkbox>
        </div>
      </FadeSlide>

      <FadeSlide delay={0.2}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <Button
            variant="primary"
            size="lg"
            disabled={!allDone}
            onClick={onDone}
            style={{ width: '100%' }}
          >
            Continue
          </Button>
          <Button variant="ghost" size="sm" onClick={onSkip} style={{ alignSelf: 'center' }}>
            I&apos;ll add it later
          </Button>
        </div>
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Step 5 — Ready
// =============================================================================

const guideCardStyle: CSSProperties = {
  flex: 1,
  minWidth: 140,
  padding: 'var(--space-4)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-subtle)',
  background: 'var(--color-surface-1)',
};

function GuideCard({
  icon,
  title,
  text,
  delay,
  onClick,
}: {
  icon: 'chat' | 'plugs-connected' | 'store';
  title: string;
  text: string;
  delay: number;
  onClick?: () => void;
}) {
  return (
    <FadeSlide delay={delay} style={{ flex: 1, minWidth: 140 }}>
      <div
        style={{ ...guideCardStyle, cursor: onClick ? 'pointer' : undefined }}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
      >
        <Icon
          name={icon}
          size="lg"
          style={{
            color: 'var(--color-interactive-default)',
            marginBottom: 'var(--space-2)',
          }}
        />
        <div
          style={{
            fontWeight: 600,
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-primary)',
            marginBottom: 'var(--space-1)',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {text}
        </div>
      </div>
    </FadeSlide>
  );
}

function StepReady({
  space,
  keysConnected,
  onEnter,
  onOpenChatWithDraft,
  onOpenStore,
}: {
  space: CreateSpaceResult;
  keysConnected: boolean;
  onEnter: () => void;
  onOpenChatWithDraft: (draft: string) => void;
  onOpenStore: () => void;
}) {
  return (
    <div>
      <FadeSlide delay={0.1}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
          <Icon
            name="check-circle"
            size="xl"
            style={{ color: 'var(--color-status-succeeded)', marginBottom: 'var(--space-2)' }}
          />
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--font-size-xl)',
              fontFamily: 'var(--font-family-title)',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
            }}
          >
            {space.name} is ready!
          </h2>
          {!keysConnected && (
            <p
              style={{
                margin: 'var(--space-2) auto 0',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-muted)',
              }}
            >
              No key connected yet — your workspace will guide you when you start chatting.
            </p>
          )}
        </div>
      </FadeSlide>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-5)',
          flexWrap: 'wrap',
        }}
      >
        <GuideCard
          icon="chat"
          title="Chat with your agent"
          text="Tell it about your processes and it'll learn to handle them."
          delay={0.2}
          onClick={onEnter}
        />
        <GuideCard
          icon="store"
          title="Browse the Store"
          text="Install ready-made skills and connectors for common work."
          delay={0.3}
          onClick={onOpenStore}
        />
        <GuideCard
          icon="plugs-connected"
          title="Connect integrations"
          text="Link your tools and APIs. Your agent helps you set them up."
          delay={0.4}
        />
      </div>

      <FadeSlide delay={0.5}>
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-muted)',
              marginBottom: 'var(--space-2)',
            }}
          >
            Try asking your agent:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => {
                  onOpenChatWithDraft(prompt);
                }}
                style={{
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--font-size-sm)',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                &ldquo;{prompt}&rdquo;
              </button>
            ))}
          </div>
        </div>
      </FadeSlide>

      <FadeSlide delay={0.6}>
        <Button variant="primary" size="lg" onClick={onEnter} style={{ width: '100%' }}>
          Go to your workspace
        </Button>
      </FadeSlide>
    </div>
  );
}

// =============================================================================
// Main flow
// =============================================================================

type Step = 'welcome' | 'workspace' | 'name' | 'model' | 'connect' | 'ready';

const STEP_ORDER: Step[] = ['welcome', 'workspace', 'model', 'connect', 'ready'];
/** A workspace that already exists enters past the two steps that make one. */
const RESUMED_STEP_ORDER: Step[] = ['name', 'model', 'connect', 'ready'];

/**
 * `resumeFor` is a workspace that already exists but cannot run — the appliance
 * bootstraps one, so the operator would otherwise never reach the model and
 * credential steps that make it answer. It carries the workspace's real
 * directives because the model step writes them back whole, and a resumed flow
 * holding a stub would replace what bootstrap and the operator put there.
 */
export function OnboardingFlow({ resumeFor }: { resumeFor?: CreateSpaceResult }) {
  const { setActiveSpaceId } = useSpace();
  const [step, setStep] = useState<Step>(resumeFor ? 'name' : 'welcome');
  const [createdSpace, setCreatedSpace] = useState<CreateSpaceResult | null>(resumeFor ?? null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [keysConnected, setKeysConnected] = useState(false);

  // Deliberately NO space-list refresh here: SpaceGate unmounts this wizard
  // the moment accessibleSpaces becomes non-empty, which would kill the
  // model/connect/ready steps. The full-page navigation at the end of the
  // flow refetches everything.
  const handleCreated = (space: CreateSpaceResult) => {
    setCreatedSpace(space);
    setStep('model');
  };

  const enterWorkspace = (path: string) => {
    if (!createdSpace) return;
    // Leaving a resumed flow without connecting anything means the workspace
    // still cannot run, and the gate that opened this would open it again on
    // the navigation below.
    if (resumeFor && !keysConnected) deferProviderSetup();
    setActiveSpaceId(createdSpace.id);
    // Full reload to re-mount with the new space context
    window.location.href = path;
  };

  const stepOrder = resumeFor ? RESUMED_STEP_ORDER : STEP_ORDER.slice(1);
  const neededProviders = selection ? providersForSelection(selection) : [];

  return (
    <div style={containerStyle}>
      <style>{fadeKeyframes}</style>
      <div style={cardStyle}>
        {step !== 'welcome' && (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            {/* The steps this run will take, which for a resumed one excludes
                the two it entered past. */}
            <StepDots total={stepOrder.length} current={stepOrder.indexOf(step)} />
          </div>
        )}

        {step === 'welcome' && (
          <StepWelcome
            onNext={() => {
              setStep('workspace');
            }}
          />
        )}
        {step === 'workspace' && (
          <StepWorkspace
            onCreated={handleCreated}
            onBack={() => {
              setStep('welcome');
            }}
          />
        )}
        {step === 'name' && createdSpace && (
          <StepNameWorkspace
            space={createdSpace}
            onDone={(named) => {
              setCreatedSpace({ ...createdSpace, name: named });
              setStep('model');
            }}
          />
        )}
        {step === 'model' && createdSpace && (
          <StepModel
            space={createdSpace}
            initial={selection}
            onDone={(sel) => {
              setSelection(sel);
              setStep('connect');
            }}
          />
        )}
        {step === 'connect' && createdSpace && (
          <StepConnect
            space={createdSpace}
            providers={neededProviders}
            onDone={() => {
              setKeysConnected(true);
              setStep('ready');
            }}
            onSkip={() => {
              setKeysConnected(false);
              setStep('ready');
            }}
            onBack={() => {
              setStep('model');
            }}
          />
        )}
        {step === 'ready' && createdSpace && (
          <StepReady
            space={createdSpace}
            keysConnected={keysConnected}
            onEnter={() => {
              enterWorkspace(`/s/${createdSpace.slug}/chat`);
            }}
            onOpenChatWithDraft={(draft) => {
              enterWorkspace(`/s/${createdSpace.slug}/chat?draft=${encodeURIComponent(draft)}`);
            }}
            onOpenStore={() => {
              enterWorkspace(`/s/${createdSpace.slug}/store`);
            }}
          />
        )}
      </div>
    </div>
  );
}
