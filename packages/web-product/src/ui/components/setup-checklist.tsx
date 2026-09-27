'use client';

import { Badge, Button, Card, CardBody, Column, Icon, Row, Text } from '@aflow/design-system';
import type { PostInstallTask } from '@aflow/schemas';
import { useEdition, type Edition } from '../hooks/useEdition.js';
import { spaceRoute } from '../lib/space-routes.js';

type IntegrationTask = Extract<
  PostInstallTask,
  { kind: 'fill_credentials' | 'fill_mcp_credentials' | 'run_mcp_binding_test' }
>;

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

export function SetupChecklist({
  tasks,
  spaceSlug,
  onNavigate,
}: {
  tasks: PostInstallTask[];
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <Column gap="sm">
      {tasks.map((task, i) => {
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
        if (task.kind === 'pair_machine') {
          return (
            <PairMachineRow
              key={`pm-${String(i)}`}
              task={task}
              spaceSlug={spaceSlug}
              onNavigate={onNavigate}
            />
          );
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
 * What the row says under its title, which is a different sentence per edition.
 *
 * `null` is the edition nobody has answered for yet, and neither branch is true
 * of it: the hosted line is a claim and the local description promises a button
 * this row withholds until the answer arrives. So it says what it is waiting
 * for — a row with a title and nothing under it reads as a defect.
 */
export function pairMachineLine(editionId: Edition['id'], description: string): string {
  if (editionId === null) return 'Checking which edition this is…';
  if (editionId === 'enterprise') {
    return (
      'These skills run on the machine that holds the work. This deployment runs in ' +
      'the cloud, so there is no computer here to pair with. Available in Aflow Local, ' +
      'which runs on your own machine.'
    );
  }
  return description;
}

/**
 * The host lane is a paired machine, not a lane a setting switches on, so this
 * row opens This Computer — a surface only the local edition serves. A hosted
 * deployment has no machine to pair, and says that instead of offering a
 * button that deterministically 404s.
 */
function PairMachineRow({
  task,
  spaceSlug,
  onNavigate,
}: {
  task: Extract<PostInstallTask, { kind: 'pair_machine' }>;
  spaceSlug: string;
  onNavigate: (path: string) => void;
}) {
  const edition = useEdition();
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Icon name="folder" size="sm" />
            <Text size="sm" weight="medium">
              Pair this machine
            </Text>
          </Row>
          <Text size="xs" variant="muted">
            {pairMachineLine(edition.id, task.description)}
          </Text>
          {edition.id === 'community-local' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onNavigate(spaceRoute(spaceSlug, '/computer'));
              }}
            >
              Open This Computer
            </Button>
          )}
        </Column>
      </CardBody>
    </Card>
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
