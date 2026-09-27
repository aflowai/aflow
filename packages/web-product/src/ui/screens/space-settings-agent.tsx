'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Dialog,
  EmptyState,
  Field,
  HelperText,
  Heading,
  Icon,
  Input,
  Label,
  PageContainer,
  Row,
  Select,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textarea,
} from '@aflow/design-system';
import {
  conversationSummariesEnabled,
  DIRECTIVE_TEMPLATES,
  EntityDirectivesSchema,
  StagedChangeKindSchema,
  type DirectiveReasoningEffort,
  type DirectiveTemplate,
  type EntityDirectives,
  type StagedChangeKind,
} from '@aflow/schemas';
import Link from 'next/link';

import { useQueryClient } from '@tanstack/react-query';
import { useApi, useSpace } from '../components/providers.js';
import { useChatModelOptions, type ModelOptionsState } from '../hooks/useChatModelOptions.js';
import {
  ModelDefaultsEditor,
  applyModelRoleChange,
  applyReasoningRoleChange,
  type ModelRole,
} from '../components/cybernetic/ModelDefaultsEditor.js';
import {
  HelmsmanDiscoveryEditor,
  withHelmsmanOperations,
} from '../components/cybernetic/HelmsmanDiscoveryEditor.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useSpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Top-level directive sections rendered as collapsible blocks. Order matches
 * the operator narrative: mandate → models → autonomy → voice/priorities →
 * resources → tools → training → coach tuning.
 */
const SECTION_ORDER = [
  'mandate',
  'modelDefaults',
  'autonomy',
  'voiceAndPriorities',
  'resourceBudget',
  'capabilityDiscovery',
  'coachTuning',
] as const;

type SectionId = (typeof SECTION_ORDER)[number];

const SECTION_META: Record<SectionId, { label: string; help: string }> = {
  mandate: {
    label: 'Mandate',
    help: 'The single statement of what this entity is for — its domain, the kinds of tasks it handles, the outcomes it owns. Anchors every executive turn.',
  },
  modelDefaults: {
    label: 'Models & reasoning',
    help: 'Which LLM each agent role uses, plus how much reasoning effort the model should spend per call. Reasoning effort is layered on top of the catalog default — leave per-role overrides empty unless a role benefits from a different setting.',
  },
  autonomy: {
    label: 'Autonomy',
    help: 'What the Learner can apply without operator review. Hard guardrails (blocking rules) live in Guardrail Policies — not here.',
  },
  voiceAndPriorities: {
    label: 'Voice & Priorities',
    help: 'Soft prompt-engineering levers. Use sparingly — load-bearing rules belong in Guardrail Policies and capability profiles.',
  },
  resourceBudget: {
    label: 'Resources',
    help: 'Hard cap on concurrent worker sessions.',
  },
  capabilityDiscovery: {
    label: 'Helmsman tools',
    help: 'The ceiling on which platform operations the Helmsman may add to its own toolbox while a session runs. Leave it on the platform default unless this space needs a narrower or wider set.',
  },
  coachTuning: {
    label: 'Coach Tuning (advanced)',
    help: 'Sampling, score floors, and cadences for the Coach. Defaults are sensible; only change if you understand the consequences.',
  },
};

const STAGED_CHANGE_KIND_OPTIONS: readonly StagedChangeKind[] = StagedChangeKindSchema.options;

/** Distinguish section titles and field labels from body / help text. */
const SECTION_ACCENT = 'var(--color-primary-default)';

const formLabelStyle: CSSProperties = {
  color: SECTION_ACCENT,
  display: 'block',
  marginBottom: 'var(--space-1)',
};

const sectionPageHeadingStyle: CSSProperties = { color: SECTION_ACCENT };

const LEARNER_ACTIVATION_OPTIONS = [
  { value: 'codified_only', label: 'Codified only — cheapest, runs on procedural runs' },
  { value: 'sampled', label: 'Sampled — runs on a percentage of all runs' },
  { value: 'always', label: 'Always — every session triggers review (expensive)' },
  { value: 'flagged', label: 'Flagged — only on anomaly/failure (most conservative)' },
] as const;
const DECAY_MODE_OPTIONS = [
  { value: 'flag', label: 'Flag stale items for review' },
  { value: 'auto_prune', label: 'Auto-prune stale items' },
] as const;

// ============================================================================
// Types
// ============================================================================

interface SpaceDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  memberCount: number;
  defaultAgentId: string | null;
  directives: EntityDirectives | null;
  createdAt: string;
  updatedAt: string;
}

interface BootstrapSummary {
  firstActivation: boolean;
  durationMs: number;
  createdArtifacts: string[];
  resolvedAgents: { helmsman: string; runner: string; coach: string };
  emittedEvent: 'entity.space.bootstrapped' | 'entity.directives.updated';
  entityEventId: string | null;
}

// ============================================================================
// Page
// ============================================================================

export function CyberneticSettingsPage() {
  const { apiUrl, headers } = useApi();
  const { activeSpace, activeSpaceId, isLoading: spaceLoading, refresh } = useSpace();
  const queryClient = useQueryClient();
  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Working copy of directives the operator is editing. `null` means
  // "cybernetic mode disabled" — toggled by Apply Template / Disable.
  const [draft, setDraft] = useState<EntityDirectives | null>(null);
  // Raw JSON tab keeps its own editable string so unparseable intermediate
  // states don't blow away the operator's typing. We re-sync from `draft`
  // when the structured tab edits.
  const [rawJson, setRawJson] = useState('');
  const [rawJsonError, setRawJsonError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'structured' | 'raw'>('structured');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapSummary | null>(null);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  const fetchSpace = useCallback(async () => {
    if (!activeSpaceId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!res.ok) throw new Error('Failed to load space');
      const data = (await res.json()) as SpaceDetail;
      setSpace(data);
      setDraft(data.directives);
      setRawJson(data.directives ? JSON.stringify(data.directives, null, 2) : '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load space');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchSpace();
  }, [fetchSpace]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const draftDirty = useMemo(() => {
    return JSON.stringify(draft) !== JSON.stringify(space?.directives ?? null);
  }, [draft, space?.directives]);

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  const applyTemplate = useCallback((template: DirectiveTemplate) => {
    // Cloning so subsequent edits don't mutate the static catalog payload.
    const next = JSON.parse(JSON.stringify(template.directives)) as EntityDirectives;
    setDraft(next);
    setRawJson(JSON.stringify(next, null, 2));
    setRawJsonError(null);
    setActiveTab('structured');
  }, []);

  const updateDraft = useCallback((mutator: (current: EntityDirectives) => EntityDirectives) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = mutator(prev);
      // Keep raw JSON tab in sync so the operator can switch tabs without
      // losing structured edits.
      setRawJson(JSON.stringify(next, null, 2));
      setRawJsonError(null);
      return next;
    });
  }, []);

  const handleRawJsonChange = useCallback((value: string) => {
    setRawJson(value);
    if (value.trim().length === 0) {
      setRawJsonError('Directives JSON cannot be empty.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      setRawJsonError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    const result = EntityDirectivesSchema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const path = firstIssue?.path.join('.') ?? '';
      setRawJsonError(`${path ? `${path}: ` : ''}${firstIssue?.message ?? 'Invalid directives'}`);
      return;
    }
    setDraft(result.data);
    setRawJsonError(null);
  }, []);

  const persistDirectives = useCallback(
    async (nextDirectives: EntityDirectives | null) => {
      if (!activeSpaceId) return;
      setSaving(true);
      setSaveError(null);
      setBootstrap(null);
      try {
        const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}`, {
          method: 'PATCH',
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'X-Space-ID': activeSpaceId,
          },
          body: JSON.stringify({ directives: nextDirectives }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(err.message ?? 'Failed to save directives');
        }
        const updated = (await res.json()) as SpaceDetail & { bootstrap?: BootstrapSummary | null };
        setSpace(updated);
        setDraft(updated.directives);
        setRawJson(updated.directives ? JSON.stringify(updated.directives, null, 2) : '');
        setBootstrap(updated.bootstrap ?? null);
        refresh();
        void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
        void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save directives');
      } finally {
        setSaving(false);
      }
    },
    [activeSpaceId, apiUrl, headers, refresh, queryClient],
  );

  const handleSave = useCallback(async () => {
    setPreviewOpen(false);
    if (!draft) return;
    await persistDirectives(draft);
  }, [draft, persistDirectives]);

  // -------------------------------------------------------------------------
  // Render — guards
  // -------------------------------------------------------------------------

  if (spaceLoading || loading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Spinner size="md" />
        </Row>
      </PageContainer>
    );
  }

  if (!activeSpace || !space) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Icon name="warning" size="xl" />}
          title="No space selected"
          description={loadError ?? 'Pick a space from the switcher to manage agent settings.'}
        />
      </PageContainer>
    );
  }

  if (!isSpaceAdmin) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Icon name="lock" size="xl" />}
          title="Admin only"
          description="Only space admins can configure the agent for this space."
        />
      </PageContainer>
    );
  }

  // -------------------------------------------------------------------------
  // Render — page body
  // -------------------------------------------------------------------------

  return (
    <PageContainer>
      <Column gap="lg">
        {/* Status header */}
        <Card>
          <CardBody>
            <Row justify="between" align="center">
              <Column gap="xs">
                <Heading level={5} style={sectionPageHeadingStyle}>
                  Agent
                </Heading>
                <Text size="xs" variant="muted">
                  Directives are this agent&apos;s constitution. Changing them re-bootstraps the
                  agent for <strong>{space.name}</strong> and emits an event on the timeline.
                </Text>
              </Column>
              <Link
                href={spaceRoute(space.slug, '/chat')}
                style={{ color: 'var(--color-content-link)', fontSize: 'var(--font-size-sm)' }}
              >
                Open chat →
              </Link>
            </Row>
          </CardBody>
        </Card>

        {/* Save success / bootstrap summary */}
        {bootstrap && (
          <Card>
            <CardBody>
              <Column gap="xs">
                <Row gap="sm" align="center">
                  <Icon name="check" size="sm" color="var(--color-status-success-fg)" />
                  <Text size="sm" weight="medium">
                    {bootstrap.firstActivation ? 'Agent activated' : 'Directives updated'}
                  </Text>
                </Row>
                <Text size="xs" variant="muted">
                  {bootstrap.firstActivation
                    ? `Bootstrap completed in ${bootstrap.durationMs}ms — created ${bootstrap.createdArtifacts.length} artifact(s).`
                    : `Re-bootstrap completed in ${bootstrap.durationMs}ms.`}{' '}
                  Emitted <code>{bootstrap.emittedEvent}</code>
                  {bootstrap.entityEventId
                    ? ` (event ${bootstrap.entityEventId.slice(0, 8)}…)`
                    : ''}
                  .
                </Text>
              </Column>
            </CardBody>
          </Card>
        )}

        {/* Save / load error */}
        {(saveError ?? loadError) && (
          <Card>
            <CardBody>
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
                <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                  {saveError ?? loadError}
                </Text>
              </Row>
            </CardBody>
          </Card>
        )}

        {/* Template picker */}
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={6} style={sectionPageHeadingStyle}>
                Templates
              </Heading>
              <Text size="xs" variant="muted">
                Apply a template to overwrite the working draft. Save to commit the change.
              </Text>
            </Column>
            <Row gap="sm" wrap>
              {DIRECTIVE_TEMPLATES.map((template) => (
                <TemplateCard key={template.id} template={template} onApply={applyTemplate} />
              ))}
            </Row>
          </Column>
        </section>

        {/* Editor */}
        <section>
          <Column gap="md">
            <Heading level={6} style={sectionPageHeadingStyle}>
              Directives
            </Heading>
            {!draft ? (
              <EmptyState
                icon={<Icon name="brain" size="lg" />}
                title="No directives yet"
                description="Pick a template above (or use Blank) to start editing. The structured form and raw JSON tab share the same draft."
              />
            ) : (
              <Tabs
                value={activeTab}
                onChange={(id) => {
                  setActiveTab(id as 'structured' | 'raw');
                }}
              >
                <TabList>
                  <Tab id="structured">Structured</Tab>
                  <Tab id="raw">Raw JSON</Tab>
                </TabList>
                <TabPanel id="structured">
                  <Column gap="md">
                    <RelatedSettingsStrip space={space} />
                    <StructuredEditor draft={draft} onChange={updateDraft} spaceId={space.id} />
                  </Column>
                </TabPanel>
                <TabPanel id="raw">
                  <RawJsonEditor
                    value={rawJson}
                    error={rawJsonError}
                    onChange={handleRawJsonChange}
                  />
                </TabPanel>
              </Tabs>
            )}
          </Column>
        </section>

        {/* Footer actions */}
        {draft && (
          <Row justify="end" align="center">
            <Row gap="sm">
              <Button
                variant="secondary"
                size="sm"
                disabled={!draftDirty || saving || rawJsonError !== null}
                onClick={() => {
                  setDraft(space.directives);
                  setRawJson(space.directives ? JSON.stringify(space.directives, null, 2) : '');
                  setRawJsonError(null);
                }}
              >
                Reset
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!draftDirty || saving || rawJsonError !== null}
                onClick={() => {
                  setPreviewOpen(true);
                }}
              >
                {saving ? 'Saving…' : 'Preview & Save'}
              </Button>
            </Row>
          </Row>
        )}
      </Column>

      {/* Preview-diff modal */}
      <PreviewDiffDialog
        open={previewOpen}
        prev={space.directives}
        next={draft}
        saving={saving}
        onCancel={() => {
          setPreviewOpen(false);
        }}
        onConfirm={() => {
          void handleSave();
        }}
      />
    </PageContainer>
  );
}

// ============================================================================
// Template card
// ============================================================================

function TemplateCard({
  template,
  onApply,
}: {
  template: DirectiveTemplate;
  onApply: (template: DirectiveTemplate) => void;
}) {
  return (
    <Card interactive style={{ width: 220 }}>
      <CardBody>
        <Column gap="xs">
          <Text variant="heading" size="sm">
            {template.name}
          </Text>
          <Text variant="muted" size="xs">
            {template.tagline}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onApply(template);
            }}
          >
            Apply
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Structured editor
// ============================================================================

function StructuredEditor({
  draft,
  onChange,
  spaceId,
}: {
  draft: EntityDirectives;
  onChange: (mutator: (current: EntityDirectives) => EntityDirectives) => void;
  spaceId: string;
}) {
  // A model the tenant has since excluded stays listed while this space holds
  // it, so the select shows what the space actually runs rather than blank.
  const storedModelRefs = Object.values(draft.modelDefaults ?? {}).filter(
    (v): v is string => typeof v === 'string',
  );
  const { modelOptions, clerkModelOptions, modelOptionsLoading, modelOptionsError } =
    useChatModelOptions(storedModelRefs);
  return (
    <Column gap="md">
      {SECTION_ORDER.map((section) => (
        <Section key={section} id={section}>
          {renderSection(section, draft, onChange, {
            modelState: {
              modelOptions,
              clerkModelOptions,
              modelOptionsLoading,
              modelOptionsError,
            },
            spaceId,
          })}
        </Section>
      ))}
    </Column>
  );
}

// ============================================================================
// Related space settings — read-only situational awareness, not editors.
//
// "Manage once" rule: every knob has exactly one editor in space settings.
// This strip surfaces space-scoped configuration that lives in other tabs so
// the operator can see context (and jump to the editor) without us building
// a duplicate inline editor here.
// ============================================================================

function RelatedSettingsStrip({ space }: { space: SpaceDetail }) {
  const items: Array<{ label: string; value: string; path: string }> = [
    {
      label: 'Default agent',
      value: space.defaultAgentId ? 'configured' : 'not set',
      path: '/settings/general',
    },
    {
      label: 'Compute',
      value: 'manage',
      path: '/settings/compute',
    },
    {
      label: 'Rules',
      value: 'manage',
      path: '/settings/rules',
    },
  ];
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Text size="xs" variant="muted">
            Other space-scoped settings affecting this entity (managed in their own tabs):
          </Text>
          <Row gap="md" wrap>
            {items.map((it) => (
              <Link
                key={it.label}
                href={spaceRoute(space.slug, it.path)}
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-interactive-default)',
                }}
              >
                {it.label}: {it.value} →
              </Link>
            ))}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

function Section({ id, children }: { id: SectionId; children: React.ReactNode }) {
  const meta = SECTION_META[id];
  // Mandate is the required identity field — open by default. Everything else
  // collapses so the page stays scannable; operators expand only what they
  // intend to edit.
  const defaultOpen = id === 'mandate';
  return (
    <details
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        backgroundColor: 'var(--surface-raised-alpha, var(--color-surface-0))',
      }}
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary
        style={{
          cursor: 'pointer',
          color: SECTION_ACCENT,
          fontWeight: 600,
          fontSize: 'var(--font-size-sm)',
          marginBottom: 'var(--space-2)',
        }}
      >
        {meta.label}
      </summary>
      <Column gap="sm" style={{ marginTop: 'var(--space-2)' }}>
        <Text size="xs" variant="muted">
          {meta.help}
        </Text>
        {children}
      </Column>
    </details>
  );
}

/** Async/route data a section needs but the plain `renderSection` cannot fetch. */
interface SectionContext {
  modelState: ModelOptionsState;
  spaceId: string;
}

function renderSection(
  section: SectionId,
  draft: EntityDirectives,
  onChange: (mutator: (current: EntityDirectives) => EntityDirectives) => void,
  ctx: SectionContext,
): React.ReactNode {
  switch (section) {
    case 'mandate':
      return (
        <Field>
          <Label style={formLabelStyle}>Responsibility</Label>
          <Textarea
            rows={5}
            value={draft.responsibility}
            onChange={(e) => {
              const value = e.target.value;
              onChange((d) => ({ ...d, responsibility: value }));
            }}
          />
          <HelperText>
            Required. Anchors every executive turn. Be specific about the domain, the kinds of tasks
            the entity handles, and the outcomes it owns.
          </HelperText>
        </Field>
      );
    case 'modelDefaults':
      return (
        <ModelDefaultsSection
          draft={draft}
          onChange={onChange}
          modelState={ctx.modelState}
          spaceId={ctx.spaceId}
        />
      );
    case 'autonomy':
      return (
        <>
          <Field>
            <Checkbox
              checked={draft.learningPolicy.enabled}
              onChange={(e) => {
                const checked = e.target.checked;
                onChange((d) => ({
                  ...d,
                  learningPolicy: { ...d.learningPolicy, enabled: checked },
                }));
              }}
              label="Learner enabled (master switch — learnings loop, Coach synthesis, validity repair)"
            />
          </Field>
          <Field>
            <Label style={formLabelStyle}>Always require operator approval for</Label>
            <Column gap="xs" style={{ paddingBlock: 'var(--space-1)' }}>
              {STAGED_CHANGE_KIND_OPTIONS.map((kind) => {
                const checked = draft.learningPolicy.alwaysRequireOperator.includes(kind);
                return (
                  <Checkbox
                    key={kind}
                    checked={checked}
                    onChange={(e) => {
                      const isChecked = e.target.checked;
                      onChange((d) => {
                        const current = d.learningPolicy.alwaysRequireOperator;
                        const next = isChecked
                          ? [...current.filter((k) => k !== kind), kind]
                          : current.filter((k) => k !== kind);
                        return {
                          ...d,
                          learningPolicy: { ...d.learningPolicy, alwaysRequireOperator: next },
                        };
                      });
                    }}
                    label={kind}
                  />
                );
              })}
            </Column>
            <HelperText>
              Change kinds that always go through staging regardless of confidence.
            </HelperText>
          </Field>
        </>
      );
    case 'voiceAndPriorities':
      return (
        <>
          <Field>
            <Label style={formLabelStyle}>Communication style</Label>
            <Textarea
              rows={3}
              value={draft.style ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                onChange((d) => {
                  const next = { ...d };
                  if (value.length > 0) next.style = value;
                  else delete next.style;
                  return next;
                });
              }}
            />
            <HelperText>
              Optional. Free-form voice guidance for operator-facing responses.
            </HelperText>
          </Field>
          <StringArrayField
            label="Priorities (ordered, max 5)"
            help="Most important first. Surfaced in the executive's attention context every turn — keep it short and load-bearing."
            values={draft.priorities}
            max={5}
            onChange={(next) => {
              onChange((d) => ({ ...d, priorities: next }));
            }}
          />
        </>
      );
    case 'resourceBudget':
      return (
        <Field>
          <Label style={formLabelStyle}>Max concurrent workers</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={draft.resourceBudget.maxConcurrentWorkers}
            onChange={(e) => {
              const value = Math.max(1, Math.min(20, Number(e.target.value) || 1));
              onChange((d) => ({
                ...d,
                resourceBudget: { ...d.resourceBudget, maxConcurrentWorkers: value },
              }));
            }}
          />
          <HelperText>Hard cap on concurrent worker sessions (1–20).</HelperText>
        </Field>
      );
    case 'capabilityDiscovery':
      return (
        <HelmsmanDiscoveryEditor
          spaceId={ctx.spaceId}
          value={draft.capabilityDiscovery?.helmsmanOperations}
          onChange={(next) => {
            onChange((d) => withHelmsmanOperations(d, next));
          }}
        />
      );
    case 'coachTuning':
      return (
        <>
          <Field>
            <Label style={formLabelStyle}>Learner activation</Label>
            <Select
              value={draft.learningPolicy.learnerActivation}
              onChange={(e) => {
                const value = e.target
                  .value as (typeof LEARNER_ACTIVATION_OPTIONS)[number]['value'];
                onChange((d) => ({
                  ...d,
                  learningPolicy: { ...d.learningPolicy, learnerActivation: value },
                }));
              }}
            >
              {LEARNER_ACTIVATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <Label style={formLabelStyle}>Decay mode</Label>
            <Select
              value={draft.learningPolicy.decayMode}
              onChange={(e) => {
                const value = e.target.value as (typeof DECAY_MODE_OPTIONS)[number]['value'];
                onChange((d) => ({
                  ...d,
                  learningPolicy: { ...d.learningPolicy, decayMode: value },
                }));
              }}
            >
              {DECAY_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>
        </>
      );
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

// ============================================================================

function ModelDefaultsSection({
  draft,
  onChange,
  modelState,
  spaceId,
}: {
  draft: EntityDirectives;
  onChange: (mutator: (current: EntityDirectives) => EntityDirectives) => void;
  modelState: ModelOptionsState;
  spaceId: string;
}) {
  const { modelOptions, clerkModelOptions, modelOptionsLoading, modelOptionsError } = modelState;
  const { readiness } = useSpaceLlmReadiness(spaceId);
  const onModelChange = (role: ModelRole, value: string | undefined) => {
    onChange((d) => ({ ...d, modelDefaults: applyModelRoleChange(d.modelDefaults, role, value) }));
  };
  const onReasoningChange = (role: ModelRole, value: DirectiveReasoningEffort | undefined) => {
    onChange((d) => ({
      ...d,
      reasoningDefaults: applyReasoningRoleChange(d.reasoningDefaults, role, value),
    }));
  };

  return (
    <ModelDefaultsEditor
      modelDefaults={draft.modelDefaults}
      reasoningDefaults={draft.reasoningDefaults}
      modelOptions={modelOptions}
      clerkModelOptions={clerkModelOptions}
      clerkReadiness={readiness?.clerk ?? null}
      conversationSummaries={conversationSummariesEnabled(draft)}
      onConversationSummariesChange={(next) => {
        onChange((d) => ({ ...d, conversationSummaries: next }));
      }}
      loading={modelOptionsLoading}
      error={modelOptionsError}
      onModelChange={onModelChange}
      onReasoningChange={onReasoningChange}
      variant="page"
      labelStyle={formLabelStyle}
    />
  );
}

// ============================================================================
// String-array editor
// ============================================================================

function StringArrayField({
  label,
  help,
  values,
  max,
  onChange,
}: {
  label: string;
  help: string;
  values: readonly string[];
  max: number;
  onChange: (next: string[]) => void;
}) {
  const [pending, setPending] = useState('');

  const add = () => {
    const trimmed = pending.trim();
    if (trimmed.length === 0) return;
    if (values.length >= max) return;
    onChange([...values, trimmed]);
    setPending('');
  };

  return (
    <Field>
      <Label style={formLabelStyle}>{label}</Label>
      <Column gap="xs">
        {values.length > 0 && (
          <Column gap="xs">
            {values.map((value, idx) => (
              <Row key={`${idx}-${value}`} gap="xs" align="center">
                <Input
                  value={value}
                  onChange={(e) => {
                    const next = [...values];
                    next[idx] = e.target.value;
                    onChange(next);
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onChange(values.filter((_, i) => i !== idx));
                  }}
                >
                  Remove
                </Button>
              </Row>
            ))}
          </Column>
        )}
        <Row gap="xs" align="center">
          <Input
            value={pending}
            placeholder={values.length >= max ? `Limit reached (${max})` : 'Add an entry…'}
            disabled={values.length >= max}
            onChange={(e) => {
              setPending(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            style={{ flex: 1 }}
          />
          <Button variant="secondary" size="sm" onClick={add} disabled={values.length >= max}>
            Add
          </Button>
        </Row>
      </Column>
      <HelperText>
        {help} ({values.length}/{max})
      </HelperText>
    </Field>
  );
}

// ============================================================================
// Raw JSON editor
// ============================================================================

function RawJsonEditor({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <Column gap="sm">
      <Textarea
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        rows={28}
        style={{ fontFamily: 'var(--font-family-mono)', fontSize: 'var(--font-size-xs)' }}
      />
      {error && (
        <Row gap="xs" align="center">
          <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
          <Text size="xs" style={{ color: 'var(--color-status-failed-fg)' }}>
            {error}
          </Text>
        </Row>
      )}
      {!error && (
        <Text size="xs" variant="muted">
          Validates against <code>EntityDirectivesSchema</code> on every keystroke. Save is disabled
          until the JSON parses.
        </Text>
      )}
    </Column>
  );
}

// ============================================================================
// Preview-diff dialog
// ============================================================================

function PreviewDiffDialog({
  open,
  prev,
  next,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  prev: EntityDirectives | null;
  next: EntityDirectives | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isFirstActivation = prev === null && next !== null;
  const changedKeys = useMemo(() => {
    if (!next) return [];
    if (!prev) return Object.keys(next).sort();
    const all = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
    return [...all]
      .filter(
        (k) =>
          JSON.stringify(prev[k as keyof EntityDirectives]) !==
          JSON.stringify(next[k as keyof EntityDirectives]),
      )
      .sort();
  }, [prev, next]);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={isFirstActivation ? 'Activate agent?' : 'Apply directive changes?'}
      width="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={saving}>
            {saving ? 'Saving…' : isFirstActivation ? 'Activate' : 'Apply changes'}
          </Button>
        </>
      }
    >
      <Column gap="md">
        {isFirstActivation ? (
          <Text size="sm">
            This will activate the agent for this space and trigger a one-time bootstrap of the
            agent ensemble (Executive, Worker, Learner). The Executive will become the default agent
            in <code>/chat</code>.
          </Text>
        ) : (
          <Text size="sm">The following top-level directive sections will change:</Text>
        )}
        {!isFirstActivation && (
          <Card>
            <CardBody>
              {changedKeys.length === 0 ? (
                <Text size="sm" variant="muted">
                  No semantic changes detected.
                </Text>
              ) : (
                <Column gap="xs">
                  {changedKeys.map((key) => (
                    <Row key={key} gap="sm" align="center">
                      <Badge variant="info">{key}</Badge>
                      <Text size="xs" variant="muted">
                        will be re-applied
                      </Text>
                    </Row>
                  ))}
                </Column>
              )}
            </CardBody>
          </Card>
        )}
        {next && (
          <details>
            <summary
              style={{ cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: 500 }}
            >
              Show full directives JSON
            </summary>
            <pre
              style={{
                marginTop: 'var(--space-2)',
                padding: 'var(--space-3)',
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-family-mono)',
                overflow: 'auto',
                maxHeight: 320,
              }}
            >
              {JSON.stringify(next, null, 2)}
            </pre>
          </details>
        )}
      </Column>
    </Dialog>
  );
}
