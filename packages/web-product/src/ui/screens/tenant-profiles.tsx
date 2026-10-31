'use client';

/**
 * Settings → Profiles: the owner's list of the people who share this install
 * (Plan 335 P2, modelled on §4). Rename a profile, change its avatar, or
 * remove it. Adding one waits for the P3 picker (see `addWouldShutOutBrowsers`).
 *
 * Local edition only, and owner only. The route ships in the local build alone,
 * and the API refuses every other caller, so the checks here only choose what
 * to say instead of a list nobody could change.
 */
import { useEffect, useState } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Table,
  Th,
  Td,
  Tr,
  Button,
  Badge,
  Text,
  Icon,
  Dialog,
  Field,
  Label,
  Input,
} from '@aflow/design-system';
import {
  LOCAL_PROFILE_AVATARS,
  type CreateLocalProfileResponse,
  type LocalProfile,
  type LocalProfileAvatar,
  type LocalProfileListResponse,
  type LocalProfileRemovalPreview,
  type RemoveLocalProfileResponse,
} from '@aflow/schemas';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { useEdition } from '../hooks/useEdition.js';
import { useCurrentUser } from '../components/user-avatar.js';
import { ProfileAvatar } from '../components/profile-avatar.js';

const PROFILES_KEY = ['local-profiles'] as const;

/**
 * What a change to the profiles makes stale: the list itself, the viewer's own
 * name and avatar when the owner edits their own profile, and the space list,
 * where a new profile's space appears to the owner by name.
 */
const INVALIDATE = [[...PROFILES_KEY], ['users', 'me'], ['spaces']];

function Loading() {
  return (
    <PageContainer>
      <Row justify="center" style={{ padding: 'var(--space-8)' }}>
        <Text variant="muted" size="sm">
          Loading...
        </Text>
      </Row>
    </PageContainer>
  );
}

export function TenantProfilesPage() {
  const edition = useEdition();
  const currentUser = useCurrentUser();
  const isLocalOwner = edition.id === 'community-local' && currentUser?.isOwner === true;

  const profiles = useApiQuery<LocalProfileListResponse>({
    key: [...PROFILES_KEY],
    path: '/local-profiles',
    enabled: isLocalOwner,
  });

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LocalProfile | null>(null);
  const [removing, setRemoving] = useState<LocalProfile | null>(null);

  if (edition.isLoading || currentUser === null) return <Loading />;

  if (!isLocalOwner) {
    return (
      <PageContainer>
        <Text variant="muted" size="sm">
          {edition.id === 'community-local'
            ? 'Only the owner of this install manages its profiles.'
            : 'Profiles belong to Aflow Local. This edition admits people through its sign-in.'}
        </Text>
      </PageContainer>
    );
  }

  if (profiles.isLoading) return <Loading />;

  const list = profiles.data?.profiles ?? [];

  // Plan 335 §4: with two profiles, a browser without a profile session is
  // refused, and nothing issues one until the P3 picker. This browser could
  // then reach neither this page nor the removal that ends the state, so the
  // screen refuses the add that would make a second profile.
  const addWouldShutOutBrowsers = list.length >= 1;

  return (
    <>
      <PageContainer>
        <Column gap="lg">
          <Row justify="between" align="center">
            <Text size="sm" variant="muted">
              Each profile has its own spaces, conversations and memory. Model keys stored for the
              whole install are shared.
            </Text>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="plus" size="sm" />}
              disabled={addWouldShutOutBrowsers}
              onClick={() => {
                setAdding(true);
              }}
            >
              Add profile
            </Button>
          </Row>
          {addWouldShutOutBrowsers && (
            <Text size="xs" variant="muted">
              Adding a profile waits for the profile picker. Once a second profile exists, every
              browser must choose a profile before it opens Aflow, this one included. This version
              cannot choose one. No browser could open Aflow again, and this page could not remove
              the profile.
            </Text>
          )}

          {profiles.error ? (
            <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
              {profiles.error.message}
            </Text>
          ) : (
            <Table>
              <thead>
                <Tr>
                  <Th style={{ width: 48 }}></Th>
                  <Th>Name</Th>
                  <Th>Added</Th>
                  <Th style={{ width: 180 }}></Th>
                </Tr>
              </thead>
              <tbody>
                {list.map((profile) => (
                  <Tr key={profile.userId}>
                    <Td>
                      <ProfileAvatar avatar={profile.avatar} size={32} />
                    </Td>
                    <Td>
                      <Row gap="sm" align="center">
                        <Text size="sm" weight="medium">
                          {profile.displayName}
                        </Text>
                        {profile.isOwner && <Badge variant="neutral">Owner</Badge>}
                        {profile.userId === currentUser.userId && (
                          <Badge variant="neutral">You</Badge>
                        )}
                      </Row>
                    </Td>
                    <Td>
                      <Text variant="muted" size="xs">
                        {new Date(profile.createdAt).toLocaleDateString()}
                      </Text>
                    </Td>
                    <Td>
                      <Row gap="sm" justify="end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(profile);
                          }}
                        >
                          Edit
                        </Button>
                        {!profile.isOwner && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setRemoving(profile);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </Row>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Column>
      </PageContainer>

      <AddProfileDialog
        open={adding && !addWouldShutOutBrowsers}
        onClose={() => {
          setAdding(false);
        }}
      />
      <EditProfileDialog
        profile={editing}
        onClose={() => {
          setEditing(null);
        }}
      />
      <RemoveProfileDialog
        profile={removing}
        onClose={() => {
          setRemoving(null);
        }}
      />
    </>
  );
}

// ============================================================================
// Name and avatar
// ============================================================================

function AvatarPicker({
  value,
  onChange,
}: {
  value: LocalProfileAvatar | null;
  onChange: (avatar: LocalProfileAvatar) => void;
}) {
  return (
    <Row gap="sm" wrap role="radiogroup" aria-label="Avatar">
      {LOCAL_PROFILE_AVATARS.map((avatar) => {
        const chosen = avatar.key === value;
        return (
          <button
            key={avatar.key}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={avatar.label}
            title={avatar.label}
            onClick={() => {
              onChange(avatar.key);
            }}
            style={{
              padding: 2,
              border: 'none',
              borderRadius: '50%',
              cursor: 'pointer',
              background: 'transparent',
              boxShadow: chosen
                ? '0 0 0 2px var(--color-surface-1), 0 0 0 4px var(--color-accent-default)'
                : 'none',
            }}
          >
            <ProfileAvatar avatar={avatar.key} size={40} />
          </button>
        );
      })}
    </Row>
  );
}

function ProfileFields({
  name,
  avatar,
  error,
  onName,
  onAvatar,
}: {
  name: string;
  avatar: LocalProfileAvatar | null;
  error: string | null;
  onName: (name: string) => void;
  onAvatar: (avatar: LocalProfileAvatar) => void;
}) {
  return (
    <Column gap="md">
      {error && (
        <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
          {error}
        </Text>
      )}
      <Field>
        <Label>Name</Label>
        <Input
          value={name}
          placeholder="e.g. Sam"
          onChange={(e) => {
            onName((e.target as HTMLInputElement).value);
          }}
        />
      </Field>
      <Field>
        <Label>Avatar</Label>
        <AvatarPicker value={avatar} onChange={onAvatar} />
      </Field>
    </Column>
  );
}

function AddProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<LocalProfileAvatar | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setAvatar(null);
      setError(null);
    }
  }, [open]);

  const add = useApiMutation<
    { displayName: string; avatar: LocalProfileAvatar },
    CreateLocalProfileResponse
  >({
    path: '/local-profiles',
    invalidate: INVALIDATE,
    onSuccess: onClose,
    onError: (err) => {
      setError(err.message);
    },
  });

  const ready = name.trim() !== '' && avatar !== null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add profile"
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={add.isPending}
            disabled={!ready}
            onClick={() => {
              if (avatar !== null) add.mutate({ displayName: name.trim(), avatar });
            }}
          >
            Add profile
          </Button>
        </Row>
      }
    >
      <Column gap="md">
        <ProfileFields
          name={name}
          avatar={avatar}
          error={error}
          onName={setName}
          onAvatar={setAvatar}
        />
        <Text size="xs" variant="muted">
          The new profile starts with a space of its own called Personal. It does not see your
          spaces.
        </Text>
      </Column>
    </Dialog>
  );
}

function EditProfileDialog({
  profile,
  onClose,
}: {
  profile: LocalProfile | null;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<LocalProfileAvatar | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setName(profile.displayName);
      setAvatar(profile.avatar);
      setError(null);
    }
  }, [profile]);

  const save = useApiMutation<
    { userId: string; displayName?: string; avatar?: LocalProfileAvatar },
    LocalProfile
  >({
    path: (input) => `/local-profiles/${encodeURIComponent(input.userId)}`,
    method: 'PATCH',
    serialize: ({ userId: _userId, ...body }) => JSON.stringify(body),
    invalidate: INVALIDATE,
    onSuccess: onClose,
    onError: (err) => {
      setError(err.message);
    },
  });

  if (!profile) return null;

  const trimmed = name.trim();
  const nameChanged = trimmed !== '' && trimmed !== profile.displayName;
  const avatarChanged = avatar !== null && avatar !== profile.avatar;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${profile.displayName}`}
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={!nameChanged && !avatarChanged}
            onClick={() => {
              save.mutate({
                userId: profile.userId,
                ...(nameChanged ? { displayName: trimmed } : {}),
                ...(avatarChanged && avatar !== null ? { avatar } : {}),
              });
            }}
          >
            Save
          </Button>
        </Row>
      }
    >
      <ProfileFields
        name={name}
        avatar={avatar}
        error={error}
        onName={setName}
        onAvatar={setAvatar}
      />
    </Dialog>
  );
}

// ============================================================================
// Remove
// ============================================================================

function RemoveProfileDialog({
  profile,
  onClose,
}: {
  profile: LocalProfile | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [profile]);

  const preview = useApiQuery<LocalProfileRemovalPreview>({
    // Outside the list's key, so removing the profile does not refetch the
    // preview of a profile that no longer exists.
    key: ['local-profile-removal', profile?.userId ?? ''],
    path: `/local-profiles/${encodeURIComponent(profile?.userId ?? '')}/removal`,
    enabled: profile !== null,
    staleTime: 0,
  });

  const remove = useApiMutation<{ userId: string }, RemoveLocalProfileResponse>({
    path: (input) => `/local-profiles/${encodeURIComponent(input.userId)}`,
    method: 'DELETE',
    invalidate: INVALIDATE,
    onSuccess: onClose,
    onError: (err) => {
      setError(err.message);
    },
  });

  if (!profile) return null;

  const deleted = preview.data?.spacesDeleted ?? [];
  const transferred = preview.data?.spacesTransferred ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${profile.displayName}?`}
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={remove.isPending}
            disabled={preview.data === undefined}
            onClick={() => {
              remove.mutate({ userId: profile.userId });
            }}
          >
            Remove profile
          </Button>
        </Row>
      }
    >
      <Column gap="md">
        {error && (
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            {error}
          </Text>
        )}
        {preview.isLoading && (
          <Text size="sm" variant="muted">
            Reading what this profile holds...
          </Text>
        )}
        {preview.error && (
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            {preview.error.message}
          </Text>
        )}
        {preview.data && (
          <>
            <Text size="sm">
              Removing this profile ends its sessions and cannot be undone.
              {deleted.length === 0
                ? ' It holds no space of its own.'
                : ' These spaces are deleted with everything in them:'}
            </Text>
            {deleted.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                {deleted.map((space) => (
                  <li key={space.spaceId}>
                    <Text size="sm">{space.name}</Text>
                  </li>
                ))}
              </ul>
            )}
            {transferred.length > 0 && (
              <Text size="sm">
                You take over the spaces it shares with others:{' '}
                {transferred.map((space) => space.name).join(', ')}.
              </Text>
            )}
          </>
        )}
      </Column>
    </Dialog>
  );
}
