'use client';

import type { ReactNode } from 'react';
import { Badge, Button, Card, CardBody, Column, Icon, Row, Text } from '@aflow/design-system';
import {
  HOST_LANE_FOLDER_REFUSAL,
  HOST_LANE_HARNESS_REFUSAL,
  HOST_LANE_PAIRING_REFUSAL,
  type PostInstallTask,
  type PostInstallTaskState,
  type ShepherdScheduleInput,
} from '@aflow/schemas';
import { useEdition, type Edition } from '../hooks/useEdition.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { spaceRoute } from '../lib/space-routes.js';

type IntegrationTask = Extract<
  PostInstallTask,
  { kind: 'fill_credentials' | 'fill_mcp_credentials' | 'run_mcp_binding_test' }
>;

/** The readiness kinds (Plan 330 D4): listed with the state they read, done included. */
type StatefulTask = Extract<PostInstallTask, { state: PostInstallTaskState }>;

/** The ones that need a paired machine, so only the local edition can change them. */
export type HostLaneTask = Extract<
  StatefulTask,
  { kind: 'pair_machine' | 'coding_harness' | 'folder_preview' }
>;

const STATE_BADGE: Record<
  PostInstallTaskState,
  { label: string; variant: 'success' | 'warning' | 'danger' }
> = {
  done: { label: 'Done', variant: 'success' },
  needs_setup: { label: 'Needs setup', variant: 'warning' },
  broken: { label: 'Broken', variant: 'danger' },
};

function readinessTitle(task: StatefulTask): string {
  switch (task.kind) {
    case 'pair_machine':
      return task.reading === 'machine' ? 'Pair this machine' : 'Connect the repository’s folder';
    case 'github_credential':
      return 'Bind a GitHub credential';
    case 'coding_harness':
      return 'Choose the coding agent';
    case 'shepherd_schedule':
      return 'Arm the shepherd schedule';
    case 'folder_preview':
      return 'Declare the folder’s preview';
  }
}

/** What the button that opens a task's page says; the host lane's own page is named in its row. */
const PAGE_LABELS: Record<string, string | undefined> = {
  '/integrations': 'Open Integrations',
  '/triggers': 'Open Triggers',
  '/agents': 'Open Agents',
  '/store/coding-loop': 'Open Coding Loop',
};

/** Settings page owning each policy-gated lane, keyed by its operation prefix. */
const POLICY_SETTINGS_PATH: Record<string, string | undefined> = {
  code: '/settings/code',
  compute: '/settings/compute',
};

function integrationDisplayName(task: IntegrationTask): string {
  const raw = 'serverId' in task ? task.serverId : task.bindingId.replace(/-default$/, '');
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The setup checklist — the derived post-install manifest as one list, the
 * same component on the bundle install, the Store page and the space's help
 * surface, so a state reads the same on each.
 */
export function SetupChecklist({
  tasks,
  spaceSlug,
  spaceId,
  onNavigate,
  onChanged,
}: {
  tasks: PostInstallTask[];
  spaceSlug: string;
  /** The space the checklist reads; arming the shepherd schedule needs it. */
  spaceId?: string;
  onNavigate: (path: string) => void;
  /** A row changed the space — the schedule was armed — so a list read before it is stale. */
  onChanged?: () => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <Column gap="sm">
      {tasks.map((task, i) => {
        if (
          task.kind === 'pair_machine' ||
          task.kind === 'coding_harness' ||
          task.kind === 'folder_preview'
        ) {
          return (
            <HostLaneRow
              key={`host-${task.kind}-${String(i)}`}
              task={task}
              spaceSlug={spaceSlug}
              onNavigate={onNavigate}
            />
          );
        }
        if (task.kind === 'github_credential') {
          return (
            <ReadinessCard
              key={`gh-${String(i)}`}
              task={task}
              actions={<OpenPageButton task={task} spaceSlug={spaceSlug} onNavigate={onNavigate} />}
            />
          );
        }
        if (task.kind === 'shepherd_schedule') {
          return (
            <ReadinessCard
              key={`sched-${String(i)}`}
              task={task}
              actions={
                <>
                  {task.schedule !== undefined && spaceId !== undefined && (
                    <ArmScheduleButton
                      schedule={task.schedule}
                      spaceId={spaceId}
                      recreate={task.state === 'broken'}
                      {...(onChanged !== undefined ? { onArmed: onChanged } : {})}
                    />
                  )}
                  <OpenPageButton task={task} spaceSlug={spaceSlug} onNavigate={onNavigate} />
                </>
              }
            />
          );
        }
        if (task.kind === 'run_mcp_binding_test') {
          return (
            <RunMcpBindingTestRow
              key={`rmbt-${task.bindingId}-${String(i)}`}
              task={task}
              spaceSlug={spaceSlug}
              onNavigate={onNavigate}
            />
          );
        }
        if (task.kind === 'designate_repo') {
          return (
            <DesignateRepoRow
              key={`dr-${String(i)}`}
              task={task}
              spaceSlug={spaceSlug}
              onNavigate={onNavigate}
            />
          );
        }
        if (task.kind === 'connect_provider') {
          return <ConnectProviderRow key={`cp-${String(i)}`} task={task} onNavigate={onNavigate} />;
        }
        if (task.kind === 'enable_space_policy') {
          return (
            <EnableSpacePolicyRow
              key={`esp-${task.policy}-${String(i)}`}
              task={task}
              spaceSlug={spaceSlug}
              onNavigate={onNavigate}
            />
          );
        }
        if (task.kind === 'assign_capability_profile') {
          return (
            <AssignCapabilityProfileRow
              key={`acp-${task.policy}-${String(i)}`}
              task={task}
              onNavigate={onNavigate}
            />
          );
        }
        return (
          <FillCredentialsRow
            key={`fc-${task.bindingId}-${String(i)}`}
            task={task}
            spaceSlug={spaceSlug}
            onNavigate={onNavigate}
          />
        );
      })}
    </Column>
  );
}

function ConnectProviderRow({
  task,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'connect_provider' }>;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="key" size="sm" />
            <Text size="sm" weight="medium">
              Connect a provider key
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Row gap="sm">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onNavigate('/settings/credentials');
              }}
            >
              Open credentials
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

/**
 * What the row says under its title, which is a different sentence per edition:
 * where no machine can be paired, the item's own refusal — pairing, connecting
 * a folder, or preferring a coding agent.
 *
 * `null` is the edition nobody has answered for yet, and neither branch is true
 * of it: the hosted line is a claim and the local description promises a button
 * this row withholds until the answer arrives. So it says what it is waiting
 * for — a row with a title and nothing under it reads as a defect.
 */
export function hostLaneLine(editionId: Edition['id'], task: HostLaneTask): string {
  if (editionId === null) return 'Checking which edition this is…';
  if (editionId === 'enterprise') {
    if (task.kind === 'coding_harness') return HOST_LANE_HARNESS_REFUSAL;
    return task.kind === 'pair_machine' && task.reading === 'machine'
      ? HOST_LANE_PAIRING_REFUSAL
      : HOST_LANE_FOLDER_REFUSAL;
  }
  return task.description;
}

/** One readiness item: its title, its state, what it reads and what changes it. */
function ReadinessCard({
  task,
  line,
  actions,
}: {
  task: StatefulTask;
  line?: string;
  actions?: ReactNode;
}) {
  const badge = STATE_BADGE[task.state];
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name={task.state === 'done' ? 'check-circle' : 'wrench'} size="sm" />
            <Text size="sm" weight="medium">
              {readinessTitle(task)}
            </Text>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {!task.required && <Badge variant="neutral">Optional</Badge>}
          </Row>
          <Text size="xs" variant="muted">
            {line ?? task.description}
          </Text>
          {task.kind === 'pair_machine' && task.folder !== undefined && (
            <Row gap="xs" wrap>
              <Badge variant="neutral">{task.folder.label}</Badge>
              <Badge variant="neutral">
                {task.folder.branchPrefix === null
                  ? 'no branch prefix'
                  : `prefix ${task.folder.branchPrefix}`}
              </Badge>
              {task.folder.mergePosture !== null && (
                <Badge variant="neutral">merge posture {task.folder.mergePosture}</Badge>
              )}
            </Row>
          )}
          {task.kind === 'github_credential' && task.missingScopes.length > 0 && (
            <Row gap="xs" wrap>
              {task.missingScopes.map((scope) => (
                <Badge key={scope} variant="warning">
                  missing {scope}
                </Badge>
              ))}
            </Row>
          )}
          {task.kind === 'coding_harness' && task.options.length > 0 && (
            <Row gap="xs" wrap>
              {task.options.map((option) => (
                <Badge key={option.id} variant={option.id === task.chosen ? 'success' : 'neutral'}>
                  {option.label}
                </Badge>
              ))}
            </Row>
          )}
          {task.command !== undefined && task.state !== 'done' && (
            <Text size="xs" style={{ fontFamily: 'monospace' }}>
              {task.command}
            </Text>
          )}
          {task.state !== 'done' && actions !== undefined && (
            <Row gap="sm" wrap>
              {actions}
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

function OpenPageButton({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: StatefulTask;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        onNavigate(spaceRoute(spaceSlug, task.page));
      }}
    >
      {PAGE_LABELS[task.page] ?? 'Open setup'}
    </Button>
  );
}

/**
 * The operator's word that creates the shepherd schedule, or recreates it from
 * what the expired one stored (Plan 330 D3). Nothing schedules it at install.
 */
function ArmScheduleButton({
  schedule,
  spaceId,
  recreate,
  onArmed,
}: {
  schedule: ShepherdScheduleInput;
  spaceId: string;
  recreate: boolean;
  onArmed?: () => void;
}) {
  const arm = useApiMutation<ShepherdScheduleInput>({
    path: '/schedules',
    method: 'POST',
    spaceId,
    serialize: (input) =>
      JSON.stringify({
        name: 'Local PR Shepherd',
        action: 'start_run',
        flowId: input.agentId,
        kind: 'cron',
        cronExpression: input.cronExpression,
        inputTemplate: input.inputTemplate,
        ...(input.maxFirings !== null ? { maxFirings: input.maxFirings } : {}),
      }),
    invalidate: [['space', spaceId]],
    onSuccess: () => {
      onArmed?.();
    },
  });
  // Once armed, the button stays spent until the list reads the schedule:
  // another press would create a second schedule beside the first.
  if (arm.isSuccess) {
    return (
      <Button variant="secondary" size="sm" disabled>
        Schedule armed
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      size="sm"
      loading={arm.isPending}
      disabled={arm.isPending}
      onClick={() => {
        arm.mutate(schedule);
      }}
    >
      {recreate ? 'Recreate the schedule' : 'Arm the schedule'}
    </Button>
  );
}

/**
 * The host lane's items — the paired machine, the connected folder, the coding
 * agent and the folder's preview — are changed on This Computer, a surface only
 * the local edition serves. A hosted deployment has no machine to pair, and
 * says that instead of offering a button that deterministically 404s.
 */
function HostLaneRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: HostLaneTask;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  const edition = useEdition();
  return (
    <ReadinessCard
      task={task}
      line={hostLaneLine(edition.id, task)}
      actions={
        edition.id === 'community-local' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate(spaceRoute(spaceSlug, task.page));
            }}
          >
            {task.page === '/computer'
              ? 'Open This Computer'
              : (PAGE_LABELS[task.page] ?? 'Open setup')}
          </Button>
        )
      }
    />
  );
}

function EnableSpacePolicyRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'enable_space_policy' }>;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="shield-check" size="sm" />
            <Text size="sm" weight="medium">
              Enable the {task.policy} lane
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate(spaceRoute(spaceSlug, POLICY_SETTINGS_PATH[task.policy] ?? '/settings'));
            }}
          >
            Open space settings
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}

function AssignCapabilityProfileRow({
  task,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'assign_capability_profile' }>;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="shield-check" size="sm" />
            <Text size="sm" weight="medium">
              {task.remedy === 'both'
                ? `Lift the tenant ceiling AND assign a profile for ${task.policy}`
                : task.remedy === 'ceiling'
                  ? `Lift the tenant ceiling on ${task.policy}`
                  : `Assign a capability profile with ${task.policy} access`}
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Row gap="xs" wrap>
            {task.missingCapabilityGroups.map((group) => (
              <Badge key={group} variant="neutral">
                {group}
              </Badge>
            ))}
          </Row>
          {/* `both` needs two visits, so it offers both destinations rather
              than implying either one finishes the job. */}
          <Row gap="sm" wrap>
            {task.remedy !== 'profile' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onNavigate('/settings/capability-governance');
                }}
              >
                Open capability governance
              </Button>
            )}
            {task.remedy !== 'ceiling' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onNavigate('/settings/access-control');
                }}
              >
                Open access control
              </Button>
            )}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

function FillCredentialsRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'fill_credentials' | 'fill_mcp_credentials' }>;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="key" size="sm" />
            <Text size="sm" weight="medium">
              Add credentials for {integrationDisplayName(task)}
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Column gap="xs">
            {task.slots.map((slot) => (
              <Row key={slot.credentialKey} gap="xs" align="center" wrap>
                <Badge variant="neutral">{slot.role}</Badge>
                <Text size="xs">{slot.label}</Text>
              </Row>
            ))}
          </Column>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate(
                spaceRoute(
                  spaceSlug,
                  `/integrations?configure=${encodeURIComponent(task.bindingId)}`,
                ),
              );
            }}
          >
            Add credentials
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}

function RunMcpBindingTestRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'run_mcp_binding_test' }>;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="play" size="sm" />
            <Text size="sm" weight="medium">
              Test the {integrationDisplayName(task)} connection
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate(
                spaceRoute(spaceSlug, `/integrations?test=${encodeURIComponent(task.bindingId)}`),
              );
            }}
          >
            Test the connection
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}

function DesignateRepoRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'designate_repo' }>;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="git-branch" size="sm" />
            <Text size="sm" weight="medium">
              Choose a coding repository
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {task.description}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate(spaceRoute(spaceSlug, '/integrations?add=repo'));
            }}
          >
            Add a coding repository
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}
