'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Grid,
  Card,
  CardBody,
  Button,
  Badge,
  Dialog,
  Input,
  Textarea,
  Select,
  Label,
  Field,
  Checkbox,
  Text,
  Heading,
  Icon,
  type IconName,
  Divider,
  Tooltip,
  Table,
  Th,
  Td,
  Tr,
  useBreakpoint,
} from '@aflow/design-system';
import {
  useCapabilityProfiles,
  type CapabilityProfile,
  type CapabilityEntry,
  type CapabilityGroupInfo,
} from '../hooks/use-capability-profiles.js';

// ============================================================================
// Constants
// ============================================================================

const RISK_MODIFIERS = [
  {
    id: 'external_side_effect',
    label: 'External Side Effects',
    description: 'Allow operations with external side effects (HTTP calls, emails, search)',
  },
  {
    id: 'privileged',
    label: 'Privileged Operations',
    description: 'Allow flow management, API definition, and platform administration',
  },
  {
    id: 'admin',
    label: 'Admin Operations',
    description: 'Allow space management and tenant administration',
  },
];

const DOMAIN_METADATA = {
  ai: { label: 'AI', icon: 'brain' },
  memory: { label: 'Memory', icon: 'database' },
  flow: { label: 'Flow', icon: 'git-branch' },
  platform: { label: 'Platform', icon: 'gear' },
  api: { label: 'API', icon: 'api' },
  user: { label: 'User', icon: 'user' },
  ui: { label: 'UI', icon: 'squares-four' },
  eval: { label: 'Evaluation', icon: 'check-circle' },
  guardrail: { label: 'Guardrail', icon: 'shield-check' },
  mcp: { label: 'MCP', icon: 'plugs' },
} as const satisfies Record<string, { label: string; icon: IconName }>;

type KnownDomain = keyof typeof DOMAIN_METADATA;

// ============================================================================
// Helpers
// ============================================================================

function getDomain(capabilityGroupId: string): string {
  const first = capabilityGroupId.split('.')[0];
  return first ?? 'other';
}

function isKnownDomain(domain: string): domain is KnownDomain {
  return Object.hasOwn(DOMAIN_METADATA, domain);
}

function getDomainMetadata(domain: string): { label: string; icon: IconName } {
  if (isKnownDomain(domain)) {
    return DOMAIN_METADATA[domain];
  }

  return {
    label: domain.charAt(0).toUpperCase() + domain.slice(1),
    icon: 'cube',
  };
}

function groupByDomain(groups: CapabilityGroupInfo[]): Map<string, CapabilityGroupInfo[]> {
  const map = new Map<string, CapabilityGroupInfo[]>();
  for (const g of groups) {
    const domain = getDomain(g.capabilityGroupId);
    const list = map.get(domain) ?? [];
    list.push(g);
    map.set(domain, list);
  }
  return map;
}

function hasCapability(capabilities: CapabilityEntry[], groupId: string, mode: string): boolean {
  return capabilities.some((c) => c.capabilityGroupId === groupId && c.accessMode === mode);
}

// ============================================================================
// Profile Form State
// ============================================================================

interface ProfileFormState {
  name: string;
  description: string;
  allowedCapabilities: CapabilityEntry[];
  allowedRiskModifiers: string[];
  allowPrivileged: boolean;
}

function emptyForm(): ProfileFormState {
  return {
    name: '',
    description: '',
    allowedCapabilities: [],
    allowedRiskModifiers: [],
    allowPrivileged: false,
  };
}

function profileToForm(p: CapabilityProfile): ProfileFormState {
  return {
    name: p.name,
    description: p.description ?? '',
    allowedCapabilities: [...p.allowedCapabilities],
    allowedRiskModifiers: [...p.allowedRiskModifiers],
    allowPrivileged: p.allowPrivileged,
  };
}

// ============================================================================
// Page
// ============================================================================

export function TenantAgentPoliciesPage() {
  const {
    profiles,
    spaces,
    assignments,
    capabilityGroups,
    isLoading,
    error,
    createProfile,
    updateProfile,
    deleteProfile,
    assignProfile,
    unassignProfile,
  } = useCapabilityProfiles();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CapabilityProfile | null>(null);
  const [form, setForm] = useState<ProfileFormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const openCreate = useCallback(() => {
    setEditingProfile(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((profile: CapabilityProfile) => {
    setEditingProfile(profile);
    setForm(profileToForm(profile));
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingProfile(null);
    setForm(emptyForm());
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editingProfile) {
        await updateProfile(editingProfile.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          allowedCapabilities: form.allowedCapabilities,
          allowedRiskModifiers: form.allowedRiskModifiers,
          allowPrivileged: form.allowPrivileged,
        });
      } else {
        await createProfile({
          name: form.name.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          allowedCapabilities: form.allowedCapabilities,
          allowedRiskModifiers: form.allowedRiskModifiers,
          allowPrivileged: form.allowPrivileged,
        });
      }
      closeDialog();
    } finally {
      setSaving(false);
    }
  }, [form, editingProfile, createProfile, updateProfile, closeDialog]);

  const handleDelete = useCallback(
    async (profile: CapabilityProfile) => {
      const confirmed = window.confirm(`Delete profile "${profile.name}"? This cannot be undone.`);
      if (!confirmed) return;
      await deleteProfile(profile.id);
    },
    [deleteProfile],
  );

  // -- Loading state --
  if (isLoading) {
    return (
      <PageContainer>
        <Column gap="lg" style={{ padding: 'var(--space-8) 0' }}>
          <Row justify="center">
            <Text variant="muted" size="sm">
              Loading policies...
            </Text>
          </Row>
        </Column>
      </PageContainer>
    );
  }

  // -- Error state --
  if (error) {
    return (
      <PageContainer>
        <Card>
          <CardBody>
            <Column gap="md" style={{ alignItems: 'center', padding: 'var(--space-6)' }}>
              <Icon name="warning" size="xl" color="var(--color-status-failed-fg)" />
              <Heading level={5}>Failed to load policies</Heading>
              <Text variant="muted" size="sm">
                {error}
              </Text>
            </Column>
          </CardBody>
        </Card>
      </PageContainer>
    );
  }

  return (
    <>
      <PageContainer>
        <Column gap="xl">
          <Row justify="end">
            <Button
              variant="primary"
              size="sm"
              onClick={openCreate}
              leftIcon={<Icon name="plus" size="sm" />}
            >
              Create Profile
            </Button>
          </Row>
          {/* -- Profile Cards -- */}
          {profiles.length === 0 ? (
            <Card>
              <CardBody>
                <Column gap="md" style={{ alignItems: 'center', padding: 'var(--space-6)' }}>
                  <Icon
                    name="shield-check"
                    size="xl"
                    weight="thin"
                    color="var(--color-content-secondary)"
                  />
                  <Heading level={5}>No capability profiles</Heading>
                  <Text variant="muted" size="sm">
                    Create a profile to control what operations AI agents can perform.
                  </Text>
                  <Button variant="primary" size="sm" onClick={openCreate}>
                    Create Profile
                  </Button>
                </Column>
              </CardBody>
            </Card>
          ) : (
            <Grid>
              {profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onEdit={openEdit}
                  onDelete={(profile) => {
                    void handleDelete(profile);
                  }}
                />
              ))}
            </Grid>
          )}

          {/* -- Space Assignments -- */}
          {spaces.length > 0 && (
            <>
              <Divider />
              <SpaceAssignmentsSection
                spaces={spaces}
                assignments={assignments}
                profiles={profiles}
                assignProfile={assignProfile}
                unassignProfile={unassignProfile}
              />
            </>
          )}
        </Column>
      </PageContainer>

      {/* -- Create / Edit Dialog -- */}
      <ProfileDialog
        open={dialogOpen}
        onClose={closeDialog}
        form={form}
        setForm={setForm}
        onSave={() => {
          void handleSave();
        }}
        saving={saving}
        isEdit={editingProfile !== null}
        capabilityGroups={capabilityGroups}
      />
    </>
  );
}

// ============================================================================
// Profile Card
// ============================================================================

function ProfileCard({
  profile,
  onEdit,
  onDelete,
}: {
  profile: CapabilityProfile;
  onEdit: (p: CapabilityProfile) => void;
  onDelete: (p: CapabilityProfile) => void;
}) {
  const capCount = profile.allowedCapabilities.length;

  return (
    <Card>
      <CardBody>
        <Column gap="md" grow>
          {/* Header */}
          <Row justify="between" align="start">
            <Column gap="xs" style={{ flex: 1, minWidth: 0 }}>
              <Heading level={6}>{profile.name}</Heading>
              {profile.description && (
                <Text
                  variant="muted"
                  size="xs"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {profile.description}
                </Text>
              )}
            </Column>
          </Row>

          {/* Badges */}
          <Row gap="sm" wrap>
            {profile.isSystemProfile && <Badge variant="neutral">System</Badge>}
            {profile.defaultForRole && (
              <Badge variant="success">
                Default:{' '}
                {profile.defaultForRole.charAt(0).toUpperCase() + profile.defaultForRole.slice(1)}
              </Badge>
            )}
            <Tooltip
              content={`${String(capCount)} allowed capability ${capCount === 1 ? 'entry' : 'entries'}`}
            >
              <Badge variant="info">{String(capCount)} capabilities</Badge>
            </Tooltip>
            {profile.allowPrivileged && <Badge variant="warning">Privileged</Badge>}
          </Row>

          {/* Risk modifiers */}
          {profile.allowedRiskModifiers.length > 0 && (
            <Row gap="xs" wrap>
              {profile.allowedRiskModifiers.map((rm) => (
                <Badge key={rm} variant="neutral">
                  <Text size="xs">{rm.replace(/_/g, ' ')}</Text>
                </Badge>
              ))}
            </Row>
          )}

          {/* Actions */}
          <Divider />
          <Row gap="sm" justify="end">
            <Button
              variant="ghost"
              size="sm"
              disabled={profile.isSystemProfile}
              onClick={() => {
                onEdit(profile);
              }}
              leftIcon={<Icon name="pencil" size="sm" />}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={profile.isSystemProfile}
              onClick={() => {
                onDelete(profile);
              }}
              leftIcon={<Icon name="trash" size="sm" />}
            >
              Delete
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Profile Dialog
// ============================================================================

function ProfileDialog({
  open,
  onClose,
  form,
  setForm,
  onSave,
  saving,
  isEdit,
  capabilityGroups,
}: {
  open: boolean;
  onClose: () => void;
  form: ProfileFormState;
  setForm: React.Dispatch<React.SetStateAction<ProfileFormState>>;
  onSave: () => void;
  saving: boolean;
  isEdit: boolean;
  capabilityGroups: CapabilityGroupInfo[];
}) {
  const domainMap = useMemo(() => groupByDomain(capabilityGroups), [capabilityGroups]);

  const toggleCapability = useCallback(
    (groupId: string, mode: 'read' | 'write', checked: boolean) => {
      setForm((prev) => {
        const filtered = prev.allowedCapabilities.filter(
          (c) => !(c.capabilityGroupId === groupId && c.accessMode === mode),
        );
        if (checked) {
          filtered.push({ capabilityGroupId: groupId, accessMode: mode });
        }
        return { ...prev, allowedCapabilities: filtered };
      });
    },
    [setForm],
  );

  const toggleRiskModifier = useCallback(
    (id: string, checked: boolean) => {
      setForm((prev) => {
        const filtered = prev.allowedRiskModifiers.filter((r) => r !== id);
        if (checked) {
          filtered.push(id);
        }
        return { ...prev, allowedRiskModifiers: filtered };
      });
    },
    [setForm],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Profile' : 'Create Profile'}
      width="xl"
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            loading={saving}
            disabled={!form.name.trim()}
          >
            {isEdit ? 'Save Changes' : 'Create Profile'}
          </Button>
        </Row>
      }
    >
      <Column gap="lg">
        {/* Name & Description */}
        <Field>
          <Label>Name</Label>
          <Input
            value={form.name}
            onChange={(e) => {
              setForm((p) => ({ ...p, name: e.target.value }));
            }}
            placeholder="e.g. Restricted Agent"
          />
        </Field>

        <Field>
          <Label>Description</Label>
          <Textarea
            value={form.description}
            onChange={(e) => {
              setForm((p) => ({ ...p, description: e.target.value }));
            }}
            placeholder="What this profile allows agents to do..."
            rows={2}
          />
        </Field>

        <Divider />

        {/* Capability Group Picker */}
        <Column gap="md">
          <Heading level={6}>Capabilities</Heading>
          <Text variant="muted" size="xs">
            Select which operation groups this profile grants access to.
          </Text>

          <Column gap="lg">
            {Array.from(domainMap.entries()).map(([domain, groups]) => (
              <DomainCapabilityGroup
                key={domain}
                domain={domain}
                groups={groups}
                allowedCapabilities={form.allowedCapabilities}
                onToggle={toggleCapability}
              />
            ))}
          </Column>
        </Column>

        <Divider />

        {/* Risk Modifiers */}
        <Column gap="md">
          <Heading level={6}>Risk Modifiers</Heading>
          <Text variant="muted" size="xs">
            Additional permissions that affect agent behavior.
          </Text>

          <Column gap="sm">
            {RISK_MODIFIERS.map((rm) => (
              <Checkbox
                key={rm.id}
                checked={form.allowedRiskModifiers.includes(rm.id)}
                onChange={(e) => {
                  toggleRiskModifier(rm.id, e.target.checked);
                }}
              >
                <Column gap="xs">
                  <Text size="sm" weight="medium">
                    {rm.label}
                  </Text>
                  <Text variant="muted" size="xs">
                    {rm.description}
                  </Text>
                </Column>
              </Checkbox>
            ))}
          </Column>
        </Column>

        <Divider />

        {/* Privileged Toggle */}
        <Checkbox
          checked={form.allowPrivileged}
          onChange={(e) => {
            setForm((p) => ({ ...p, allowPrivileged: e.target.checked }));
          }}
        >
          <Column gap="xs">
            <Row gap="sm" align="center">
              <Text size="sm" weight="medium">
                Allow Privileged Operations
              </Text>
              <Badge variant="warning">Elevated</Badge>
            </Row>
            <Text variant="muted" size="xs">
              Grants access to privileged operations that bypass normal safety checks.
            </Text>
          </Column>
        </Checkbox>
      </Column>
    </Dialog>
  );
}

// ============================================================================
// Domain Capability Group
// ============================================================================

function DomainCapabilityGroup({
  domain,
  groups,
  allowedCapabilities,
  onToggle,
}: {
  domain: string;
  groups: CapabilityGroupInfo[];
  allowedCapabilities: CapabilityEntry[];
  onToggle: (groupId: string, mode: 'read' | 'write', checked: boolean) => void;
}) {
  const { icon: iconName, label } = getDomainMetadata(domain);

  return (
    <Column gap="sm">
      <Row gap="sm" align="center">
        <Icon name={iconName} size="sm" color="var(--color-content-secondary)" />
        <Text size="sm" weight="semibold">
          {label}
        </Text>
        <Text variant="muted" size="xs">
          ({String(groups.length)})
        </Text>
      </Row>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 'var(--space-2)',
          paddingLeft: 'var(--space-5)',
        }}
      >
        {groups.map((group) => (
          <div
            key={group.capabilityGroupId}
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border-subtle)',
              backgroundColor: 'var(--color-bg-secondary)',
            }}
          >
            <Column gap="xs">
              <Tooltip content={group.description}>
                <Text size="xs" weight="medium" style={{ cursor: 'help' }}>
                  {group.label || group.capabilityGroupId}
                </Text>
              </Tooltip>
              <Row gap="md">
                {group.supportedAccessModes.map((mode) => (
                  <Checkbox
                    key={mode}
                    size="sm"
                    checked={hasCapability(allowedCapabilities, group.capabilityGroupId, mode)}
                    onChange={(e) => {
                      onToggle(group.capabilityGroupId, mode as 'read' | 'write', e.target.checked);
                    }}
                  >
                    <Text size="xs" style={{ textTransform: 'capitalize' }}>
                      {mode}
                    </Text>
                  </Checkbox>
                ))}
              </Row>
            </Column>
          </div>
        ))}
      </div>
    </Column>
  );
}

// ============================================================================
// Space Assignments Section
// ============================================================================

function SpaceAssignmentsSection({
  spaces,
  assignments,
  profiles,
  assignProfile,
  unassignProfile,
}: {
  spaces: Array<{ id: string; name: string; slug: string }>;
  assignments: Map<
    string,
    { spaceId: string; profileId: string | null; profileName: string | null }
  >;
  profiles: CapabilityProfile[];
  assignProfile: (spaceId: string, profileId: string) => Promise<boolean>;
  unassignProfile: (spaceId: string) => Promise<boolean>;
}) {
  const { isMobile } = useBreakpoint();
  const [busySpaceId, setBusySpaceId] = useState<string | null>(null);

  const handleAssign = useCallback(
    async (spaceId: string, profileId: string) => {
      setBusySpaceId(spaceId);
      try {
        if (profileId === '') {
          await unassignProfile(spaceId);
        } else {
          await assignProfile(spaceId, profileId);
        }
      } finally {
        setBusySpaceId(null);
      }
    },
    [assignProfile, unassignProfile],
  );

  const handleClear = useCallback(
    async (spaceId: string) => {
      setBusySpaceId(spaceId);
      try {
        await unassignProfile(spaceId);
      } finally {
        setBusySpaceId(null);
      }
    },
    [unassignProfile],
  );

  return (
    <Column gap="md">
      <Heading level={5}>Space Assignments</Heading>
      <Text variant="muted" size="sm">
        Override the default role-based profile for specific spaces. When no profile is assigned,
        the space uses the default profile for the agent&apos;s role.
      </Text>

      {isMobile ? (
        <Column gap="sm">
          {spaces.map((space) => {
            const assignment = assignments.get(space.id);
            const currentProfileId = assignment?.profileId ?? '';
            const isBusy = busySpaceId === space.id;

            return (
              <Card key={space.id}>
                <CardBody>
                  <Column gap="sm">
                    <Text size="sm" weight="medium">
                      {space.name}
                    </Text>
                    <Text variant="muted" size="xs">
                      {currentProfileId ? (assignment?.profileName ?? 'Assigned') : 'Role Default'}
                    </Text>
                    <Select
                      value={currentProfileId}
                      onChange={(e) => {
                        void handleAssign(space.id, e.target.value);
                      }}
                      disabled={isBusy}
                    >
                      <option value="">Role Default</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                    {currentProfileId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void handleClear(space.id);
                        }}
                        disabled={isBusy}
                      >
                        Clear
                      </Button>
                    )}
                  </Column>
                </CardBody>
              </Card>
            );
          })}
        </Column>
      ) : (
        <Table>
          <thead>
            <Tr>
              <Th>Space</Th>
              <Th>Current Profile</Th>
              <Th>Assign Profile</Th>
              <Th style={{ width: 80 }}></Th>
            </Tr>
          </thead>
          <tbody>
            {spaces.map((space) => {
              const assignment = assignments.get(space.id);
              const currentProfileId = assignment?.profileId ?? '';
              const isBusy = busySpaceId === space.id;

              return (
                <Tr key={space.id}>
                  <Td>
                    <Column gap="xs">
                      <Text size="sm" weight="medium">
                        {space.name}
                      </Text>
                      <Text variant="muted" size="xs">
                        {space.slug}
                      </Text>
                    </Column>
                  </Td>
                  <Td>
                    {currentProfileId ? (
                      <Badge variant="info">{assignment?.profileName ?? 'Assigned'}</Badge>
                    ) : (
                      <Text variant="muted" size="xs">
                        Role Default
                      </Text>
                    )}
                  </Td>
                  <Td>
                    <Select
                      value={currentProfileId}
                      onChange={(e) => {
                        void handleAssign(space.id, e.target.value);
                      }}
                      disabled={isBusy}
                      style={{ maxWidth: 240 }}
                    >
                      <option value="">Role Default</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Td>
                  <Td>
                    {currentProfileId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void handleClear(space.id);
                        }}
                        disabled={isBusy}
                        leftIcon={<Icon name="x" size="sm" />}
                      >
                        Clear
                      </Button>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Column>
  );
}
