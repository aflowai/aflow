'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { isSoloSpace, useSpace, type SpaceInfo } from './providers.js';
import { Icon, Spinner } from '@aflow/design-system';
import { OnboardingFlow } from './onboarding-flow.js';
import type { CreateSpaceResult } from './create-space-form.js';
import { isProviderSetupDeferred } from './provider-setup-deferral.js';
import { useEdition, type Edition } from '../hooks/useEdition.js';
import { useSpaceLlmReadiness, type SpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';
import { useSpaceDetail, type SpaceDetail } from '../hooks/use-space-detail.js';

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100%',
  padding: 'var(--space-6)',
};

const cardStyle: React.CSSProperties = {
  maxWidth: 400,
  width: '100%',
  padding: 'var(--space-6)',
  background: 'var(--color-surface-1)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-lg)',
};

export function SpacePicker() {
  const { accessibleSpaces, setActiveSpaceId, isLoading } = useSpace();
  const router = useRouter();

  if (isLoading) {
    return (
      <div style={containerStyle}>
        <Spinner size="xl" label="Loading spaces" />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--font-size-lg)',
            fontFamily: 'var(--font-family-title)',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            marginBottom: 'var(--space-1)',
          }}
        >
          Select a workspace
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-4)',
          }}
        >
          Choose the workspace you want to work in. You can switch later from the sidebar.
        </p>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            maxHeight: '50vh',
            overflowY: 'auto',
          }}
        >
          {accessibleSpaces.map((space) => (
            <SpaceItem
              key={space.id}
              space={space}
              onSelect={(id) => {
                // Where the sidebar's switcher goes. Setting the active space
                // alone leaves the visitor on a route that does not name one,
                // which renders this same screen again.
                setActiveSpaceId(id);
                router.push(`/s/${encodeURIComponent(space.slug)}/chat`);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SpaceItem({ space, onSelect }: { space: SpaceInfo; onSelect: (id: string) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        background: hovered ? 'var(--color-surface-2)' : 'transparent',
        border: '1px solid',
        borderColor: hovered ? 'var(--color-border-default)' : 'var(--color-border-subtle)',
        transition: 'all 120ms',
      }}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onClick={() => {
        onSelect(space.id);
      }}
    >
      <Icon
        name={isSoloSpace(space) ? 'robot' : 'buildings'}
        size="md"
        style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          {space.name}
        </div>
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
          }}
        >
          {isSoloSpace(space) ? 'Personal workspace' : `Shared · ${space.memberCount} members`}
        </div>
      </div>
    </div>
  );
}

/**
 * The appliance boots with a workspace already made, so the wizard that names
 * one never opens — and the steps behind it, which choose a model and take the
 * key that makes it answer, were only reachable through it. What the operator
 * met instead was a chat that could not reply, which is the one completion
 * state the first-run design rules out.
 *
 * Only the local edition is gated. The hosted product admits people into
 * workspaces somebody else configured, where the reader of an unready space is
 * often not the person holding its credentials — stopping them at a setup
 * screen would block work they can do to demand something they cannot.
 */
export function resolveProviderSetupResume(input: {
  editionId: Edition['id'];
  /** The active space. Taken from context, not read back off the payload. */
  spaceId: string | null;
  readiness: SpaceLlmReadiness | null;
  space: SpaceDetail | null;
  deferred: boolean;
}): CreateSpaceResult | null {
  if (input.editionId !== 'community-local') return null;
  // Every condition waits for an answer rather than assuming one. Readiness is
  // null until the server replies, and treating that as unready would flash a
  // setup screen in front of a workspace that turns out to be fine.
  if (input.readiness === null) return null;
  // A key nothing has tried is unfinished setup, not finished setup. The flow
  // says as much when a check fails — "you can continue and fix it later" —
  // and without this there is no later: `ready` is true from the moment a row
  // exists, so nothing would raise it again.
  const unverified = input.readiness.unverifiedProviders ?? [];
  if (input.readiness.ready && unverified.length === 0) return null;
  // First run is "nothing has ever been configured", not "cannot run now".
  // Gating on the second put the wizard in front of every page the moment an
  // operator picked a model whose provider had no key — and because the wizard
  // ends in a reload that recomputes the same condition, it could not be left.
  // A workspace that already holds a key has the readiness banner for this: it
  // names the provider and offers the fix without replacing the app.
  if (input.readiness.hasConfiguredProvider) return null;
  if (input.deferred) return null;
  // The workspace's real directives, which the model step writes back whole.
  if (input.space === null || input.spaceId === null) return null;

  return {
    id: input.spaceId,
    name: input.space.name,
    slug: input.space.slug,
    directives: input.space.directives,
  };
}

function useResumableProviderSetup(spaceId: string | null): CreateSpaceResult | null {
  const edition = useEdition();
  const local = edition.id === 'community-local';
  const { readiness } = useSpaceLlmReadiness(local ? spaceId : null);
  const { space } = useSpaceDetail(local ? spaceId : null);

  return resolveProviderSetupResume({
    editionId: edition.id,
    spaceId,
    readiness,
    space,
    // Read only where it can matter. This runs in render on every page of the
    // app, and the hosted edition has no use for the answer.
    deferred: local ? isProviderSetupDeferred() : false,
  });
}

export function SpaceGate({ children }: { children: ReactNode }) {
  const { activeSpaceId, accessibleSpaces, isLoading } = useSpace();
  const resumeFor = useResumableProviderSetup(activeSpaceId);

  if (isLoading) {
    return (
      <div style={containerStyle}>
        <Spinner size="xl" label="Loading" />
      </div>
    );
  }

  if (accessibleSpaces.length === 0) {
    return <OnboardingFlow />;
  }

  if (!activeSpaceId) {
    return <SpacePicker />;
  }

  if (resumeFor) {
    return <OnboardingFlow resumeFor={resumeFor} />;
  }

  return <>{children}</>;
}
