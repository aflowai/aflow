'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Button,
  Column,
  EmptyState,
  Icon,
  JsonViewer,
  Row,
  Spinner,
  Text,
  useBreakpoint,
} from '@aflow/design-system';
import type { QueryKey } from '@tanstack/react-query';
import type { Workflow, SkillValidity, SkillCampaignContract } from '@aflow/schemas';

import { useCybernetic } from '../components/cybernetic-provider.js';
import { useNavigation } from '../components/navigation-provider.js';
import { useApi } from '../components/providers.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { spaceRoute } from '../lib/space-routes.js';
import { SkillDesigner } from '../components/skill-designer/SkillDesigner.js';
import { SkillSwitcher, type SkillSummary } from '../components/skills/SkillSwitcher.js';
import { CloneSkillDialog } from '../components/skills/CloneSkillDialog.js';
import { NewSkillDialog } from '../components/skills/NewSkillDialog.js';
import { useAgentStepCounts } from '../components/skills/useAgentStepCounts.js';
import { RunsTab } from '../components/workflow-runs-tab.js';
import { ProposalsTab } from '../components/workflow-proposals-tab.js';
import { SkillFeedbackTab } from '../components/skill-feedback-tab.js';
import { WorkflowHealthTab } from '../components/workflow-health-tab.js';
import { EvalsTab } from '../components/evals-tab/EvalsTab.js';
import { DangerZoneTab } from '../components/skill-designer/danger-zone-tab.js';

interface WorkflowSummary extends SkillSummary {
  description: string;
  system?: boolean;
  purgedAt?: string | null;
}

interface WorkflowDetail {
  workflow?: Workflow;
  contractValidity?: SkillValidity;
  campaign?: SkillCampaignContract;
  validationError?: string | null;
}

function workflowDetailKey(spaceId: string, slug: string, includeArchived: boolean): QueryKey {
  return ['space', spaceId, 'workflow', slug, includeArchived ? 'archived' : 'live'];
}

// Old standalone-page `?tab=` values redirect here, so keep their links working.
const TAB_ALIASES: Record<string, string> = {
  health: 'performance',
  measurement: 'evals',
  'proposals-feedback': 'proposals',
  definition: 'raw',
};

const PRIMARY_TABS = [
  { id: 'design', label: 'Design' },
  { id: 'performance', label: 'Performance' },
  { id: 'evals', label: 'Evals' },
  { id: 'runs', label: 'Runs' },
] as const;

const MORE_TABS = [
  { id: 'raw', label: 'Raw config' },
  { id: 'proposals', label: 'Proposals & Feedback' },
  { id: 'danger', label: 'Danger zone' },
] as const;

export function SkillsPage() {
  const params = useParams();
  const spaceSlug = String(params['space']);
  const { spaceId } = useCybernetic();
  const { apiUrl, headers } = useApi();
  const { push } = useNavigation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const skillParam = searchParams?.get('skill') ?? null;
  const { isMobile } = useBreakpoint();
  // The graph designer needs a pointer and a wide canvas; phones land on the
  // read-only Performance tab instead (an explicit ?tab= still wins).
  const tabParam = searchParams?.get('tab') ?? (isMobile ? 'performance' : 'design');
  const tab = TAB_ALIASES[tabParam] ?? tabParam;

  const listQuery = useApiQuery<{ workflows: WorkflowSummary[] }>({
    key: ['space', spaceId, 'workflows', 'all'],
    path: `/spaces/${spaceId}/workflows?archived=true`,
    spaceId,
    staleTime: 30_000,
  });

  const skills = useMemo<WorkflowSummary[]>(
    () => (listQuery.data?.workflows ?? []).filter((w) => !w.system && !w.purgedAt),
    [listQuery.data],
  );

  const defaultSlug = skills.find((s) => !s.archivedAt)?.slug ?? skills[0]?.slug ?? null;
  const selectedSlug = skillParam ?? defaultSlug;
  const selectedSkill = skills.find((s) => s.slug === selectedSlug) ?? null;
  const includeArchived = !!selectedSkill?.archivedAt;

  // Land directly on a skill: when none is in the URL, pin the first one so the
  // view is shareable and the switcher reflects the selection.
  useEffect(() => {
    if (!skillParam && defaultSlug) {
      router.replace(spaceRoute(spaceSlug, `/skills?skill=${defaultSlug}`), { scroll: false });
    }
  }, [skillParam, defaultSlug, router, spaceSlug]);

  const detailQuery = useApiQuery<WorkflowDetail>({
    key: selectedSlug
      ? workflowDetailKey(spaceId, selectedSlug, includeArchived)
      : ['space', spaceId, 'workflow', '__none__'],
    path: `/spaces/${spaceId}/workflows/${selectedSlug ?? ''}${includeArchived ? '?includeArchived=true' : ''}`,
    spaceId,
    staleTime: 30_000,
    enabled: !!selectedSlug,
  });

  const detail = detailQuery.data;
  const wf = detail?.workflow;
  const agentStepCounts = useAgentStepCounts(spaceId, wf);

  const [dirty, setDirty] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [moreOpen]);

  const onSelect = (slug: string) => {
    if (slug === selectedSlug) return;
    if (dirty && !window.confirm('Discard unsaved changes to this skill?')) return;
    router.replace(spaceRoute(spaceSlug, `/skills?skill=${slug}&tab=${tab}`), { scroll: false });
  };

  const goToTab = (next: string) => {
    setMoreOpen(false);
    const qs = selectedSlug ? `?skill=${selectedSlug}&tab=${next}` : `?tab=${next}`;
    router.replace(spaceRoute(spaceSlug, `/skills${qs}`), { scroll: false });
  };

  const onCreated = (slug: string) => {
    setNewOpen(false);
    router.replace(spaceRoute(spaceSlug, `/skills?skill=${slug}&tab=design`), { scroll: false });
  };

  const newSkillDialog = (
    <NewSkillDialog
      open={newOpen}
      onClose={() => {
        setNewOpen(false);
      }}
      spaceId={spaceId}
      onCreated={onCreated}
    />
  );

  const cloneSkillDialog = selectedSkill && (
    <CloneSkillDialog
      open={cloneOpen}
      onClose={() => {
        setCloneOpen(false);
      }}
      spaceId={spaceId}
      sourceSlug={selectedSkill.slug}
      sourceName={selectedSkill.name}
      onCloned={(slug) => {
        setCloneOpen(false);
        router.replace(spaceRoute(spaceSlug, `/skills?skill=${slug}&tab=design`), {
          scroll: false,
        });
      }}
    />
  );

  const switcher = (
    <Row gap="sm" align="center">
      <SkillSwitcher skills={skills} selectedSlug={selectedSlug} onSelect={onSelect} />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setNewOpen(true);
        }}
      >
        <Icon name="plus" size="xs" /> New skill
      </Button>
      {selectedSkill && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setCloneOpen(true);
          }}
        >
          <Icon name="copy" size="xs" /> Clone
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          push(spaceRoute(spaceSlug, '/store?kind=skill'));
        }}
      >
        Skill store
      </Button>
    </Row>
  );

  if (listQuery.isLoading) {
    return (
      <Row justify="center" style={{ flex: 1, alignItems: 'center' }}>
        <Spinner size="xl" label="Loading skills" />
      </Row>
    );
  }

  if (listQuery.error) {
    return (
      <Column
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 'var(--space-sm)' }}
      >
        <Icon name="warning" size="lg" />
        <Text size="base">Couldn’t load skills.</Text>
        <Button variant="secondary" onClick={() => void listQuery.refetch()}>
          Retry
        </Button>
      </Column>
    );
  }

  if (skills.length === 0) {
    return (
      <Column
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 'var(--space-md)' }}
      >
        <EmptyState
          icon={<Icon name="skill" size={48} color="var(--color-accent-default)" />}
          title="No skills yet"
          description="Describe one to Helmsman, start from a template, or install one from the Store."
        />
        <Row gap="sm">
          <Button
            variant="primary"
            onClick={() => {
              setNewOpen(true);
            }}
          >
            <Icon name="plus" size="xs" /> New skill
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              push(spaceRoute(spaceSlug, '/store?kind=skill'));
            }}
          >
            Browse skill store
          </Button>
        </Row>
        {newSkillDialog}
      </Column>
    );
  }

  const tabScroll: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}
    >
      {newSkillDialog}
      {cloneSkillDialog}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          flexWrap: 'wrap',
        }}
      >
        {switcher}
        {wf && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            {PRIMARY_TABS.map((t) => (
              <TabBtn
                key={t.id}
                active={tab === t.id}
                label={t.label}
                onClick={() => {
                  goToTab(t.id);
                }}
              />
            ))}
            <div ref={moreRef} style={{ position: 'relative' }}>
              <TabBtn
                active={MORE_TABS.some((t) => t.id === tab)}
                label="More ▾"
                onClick={() => {
                  setMoreOpen((o) => !o);
                }}
              />
              {moreOpen && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '100%',
                    marginTop: 4,
                    zIndex: 'var(--z-popover)' as unknown as number,
                    background: 'var(--color-surface-1)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-md)',
                    minWidth: 190,
                    padding: 4,
                  }}
                >
                  {MORE_TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        goToTab(t.id);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 10px',
                        border: 'none',
                        background: tab === t.id ? 'var(--color-surface-2)' : 'transparent',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        color: 'var(--color-text-primary)',
                        fontSize: 13,
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {!wf ? (
        <Row justify="center" style={{ flex: 1, alignItems: 'center' }}>
          {detailQuery.isLoading ? (
            <Spinner size="lg" label="Loading skill" />
          ) : detailQuery.error ? (
            <Column style={{ alignItems: 'center', gap: 'var(--space-sm)' }}>
              <Icon name="warning" size="lg" />
              <Text size="base">Couldn’t load this skill.</Text>
              <Button variant="secondary" onClick={() => void detailQuery.refetch()}>
                Retry
              </Button>
            </Column>
          ) : detail?.validationError ? (
            <Column
              style={{
                alignItems: 'center',
                gap: 'var(--space-sm)',
                maxWidth: 480,
                textAlign: 'center',
              }}
            >
              <Icon name="warning" size="lg" />
              <Text size="base">This skill failed validation and needs repair by the agent.</Text>
            </Column>
          ) : (
            <Text size="base" color="muted">
              Select a skill.
            </Text>
          )}
        </Row>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Phones get an explicit gate instead of the multi-rail canvas; the
              read-only tabs remain the mobile surface for this skill. */}
          {isMobile && tab === 'design' && (
            <div style={tabScroll}>
              <EmptyState
                icon={<Icon name="expand" size="xl" />}
                title="The Skill Designer needs a larger screen"
                description="Editing the skill graph requires a pointer and a wide canvas. On this device you can still review performance, runs, and proposals — or open this page on a desktop to edit."
                action={
                  <Row gap="sm" wrap justify="center">
                    <Button
                      variant="primary"
                      onClick={() => {
                        goToTab('performance');
                      }}
                    >
                      View performance
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        goToTab('runs');
                      }}
                    >
                      View runs
                    </Button>
                  </Row>
                }
              />
            </div>
          )}
          {/* Design stays mounted so the in-progress draft survives tab switches. */}
          {!isMobile && (
            <div
              style={{
                display: tab === 'design' ? 'flex' : 'none',
                flex: 1,
                minHeight: 0,
                flexDirection: 'column',
              }}
            >
              <SkillDesigner
                workflow={wf}
                contractValidity={detail?.contractValidity}
                campaignContract={detail?.campaign}
                agentStepCounts={agentStepCounts}
                spaceId={spaceId}
                slug={selectedSlug ?? ''}
                onDirtyChange={setDirty}
                active={tab === 'design'}
              />
            </div>
          )}
          {tab === 'performance' && (
            <div style={tabScroll}>
              <WorkflowHealthTab
                spaceId={spaceId}
                workflowSlug={selectedSlug ?? ''}
                workflow={wf}
                campaignContract={detail?.campaign}
                onOpenProposals={() => {
                  goToTab('proposals');
                }}
              />
            </div>
          )}
          {tab === 'evals' && (
            <div style={tabScroll}>
              <EvalsTab spaceId={spaceId} workflowSlug={selectedSlug ?? ''} />
            </div>
          )}
          {tab === 'runs' && (
            <div style={tabScroll}>
              <RunsTab spaceId={spaceId} workflowSlug={selectedSlug ?? ''} mode={wf.mode} />
            </div>
          )}
          {tab === 'raw' && (
            <div style={tabScroll}>
              <div
                style={{
                  maxWidth: 1000,
                  margin: '0 auto',
                  width: '100%',
                  padding: 'var(--space-5)',
                }}
              >
                <JsonViewer data={wf} collapsed={false} collapseDepth={1} copyable />
              </div>
            </div>
          )}
          {tab === 'proposals' && (
            <div style={tabScroll}>
              <Column>
                <ProposalsTab spaceId={spaceId} workflowSlug={selectedSlug ?? ''} />
                <SkillFeedbackTab spaceId={spaceId} skillSlug={selectedSlug ?? ''} />
              </Column>
            </div>
          )}
          {tab === 'danger' && (
            <div style={tabScroll}>
              <DangerZoneTab
                apiUrl={apiUrl}
                headers={headers}
                spaceId={spaceId}
                skillId={selectedSlug ?? ''}
                skillName={wf.name}
                archivedAt={selectedSkill?.archivedAt ?? null}
                isPlatformSkill={wf.origin === 'platform'}
                onActionCompleted={() => {
                  push(spaceRoute(spaceSlug, '/skills'));
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: 'none',
        borderBottom: active ? '2px solid var(--color-content-primary)' : '2px solid transparent',
        background: 'transparent',
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        fontWeight: active ? 600 : 400,
        fontSize: 'var(--font-size-sm)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}
