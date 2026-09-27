'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input, Textarea } from '@aflow/design-system';
import { useApi } from './providers.js';
import { useCurrentUser } from './user-avatar.js';

// =============================================================================
// Types
// =============================================================================

export interface CreateSpaceResult {
  id: string;
  name: string;
  slug: string;
  /** Server-resolved directives (blank template + responsibility) — carried so
   *  later onboarding steps can PATCH modelDefaults without a refetch. */
  directives: Record<string, unknown> | null;
}

export interface CreateSpaceFormProps {
  /** Called after successful space creation */
  onCreated: (space: CreateSpaceResult) => void;
  /** Called on error */
  onError?: (error: string) => void;
  /** Whether to auto-focus the name input */
  autoFocus?: boolean;
  /** Submit button label (default: "Create workspace") */
  submitLabel?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/** Number of `-N` suffix attempts before falling back to a random suffix. */
const RESOLVE_SUFFIX_LIMIT = 9;

/** Truncate so `${base}-{suffix}` stays under 64 chars (the AgentSlug max). */
function withSuffix(base: string, suffix: string): string {
  const max = 64;
  const reserve = `-${suffix}`.length;
  const head =
    base.length + reserve <= max ? base : base.slice(0, max - reserve).replace(/-+$/, '');
  return `${head}-${suffix}`;
}

/** Short, kebab-friendly random suffix — 5 lowercase alphanumerics. */
function randomShortSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 5; i++) {
    // `charAt` rather than an index: the index is always in range, and this
    // package checks indexed access where the application did not.
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

// =============================================================================
// Form
// =============================================================================

export function CreateSpaceForm({
  onCreated,
  onError,
  autoFocus = false,
  submitLabel = 'Create workspace',
}: CreateSpaceFormProps) {
  const { headers, authFetch } = useApi();
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const slugCheckTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [name, setName] = useState('');
  /** Slug derived from the name — what the user "asked for". May not be unique. */
  const [baseSlug, setBaseSlug] = useState('');
  const [effectiveSlug, setEffectiveSlug] = useState('');
  const [slugResolving, setSlugResolving] = useState(false);
  const [description, setDescription] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseSlug) {
      setEffectiveSlug('');
      setSlugResolving(false);
      return;
    }
    setSlugResolving(true);
    clearTimeout(slugCheckTimer.current);
    let cancelled = false;

    const checkAvailable = async (candidate: string): Promise<boolean> => {
      try {
        const res = await authFetch(
          `/api/spaces/check-slug?slug=${encodeURIComponent(candidate)}`,
          { headers: headers() },
        );
        if (!res.ok) return false;
        const data = (await res.json()) as { status: string };
        return data.status === 'available';
      } catch {
        // Network error — assume not available so we keep trying; the
        // POST will return 409 if the resolver was wrong and the user
        // can retry.
        return false;
      }
    };

    slugCheckTimer.current = setTimeout(() => {
      void (async () => {
        const candidates: string[] = [baseSlug];
        for (let i = 2; i <= RESOLVE_SUFFIX_LIMIT + 1; i++) {
          candidates.push(withSuffix(baseSlug, String(i)));
        }
        // Final fallback: random short suffix. Two tries because random
        // collisions are astronomically rare but not impossible.
        candidates.push(withSuffix(baseSlug, randomShortSuffix()));
        candidates.push(withSuffix(baseSlug, randomShortSuffix()));

        for (const candidate of candidates) {
          if (cancelled) return;
          if (await checkAvailable(candidate)) {
            if (cancelled) return;
            setEffectiveSlug(candidate);
            setSlugResolving(false);
            return;
          }
        }
        // Everything collided — leave the baseSlug as-is and let the
        // server's 409 surface (extremely unlikely path).
        if (!cancelled) {
          setEffectiveSlug(baseSlug);
          setSlugResolving(false);
        }
      })();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(slugCheckTimer.current);
    };
  }, [baseSlug, headers, authFetch]);

  useEffect(() => {
    if (autoFocus && nameRef.current) {
      nameRef.current.focus();
    }
  }, [autoFocus]);

  const handleNameChange = useCallback((value: string) => {
    setName(value);
    setBaseSlug(toSlug(value));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !effectiveSlug.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      // Responsibility rides top-level on EntityDirectives; the server fills
      // the remaining defaulted fields from the blank template.
      const directives = responsibility.trim()
        ? { version: 1, responsibility: responsibility.trim() }
        : undefined;

      const res = await authFetch('/api/spaces', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: name.trim(),
          slug: effectiveSlug.trim(),
          description: description.trim() || undefined,
          directives,
        }),
      });

      if (res.status === 409) {
        // Should be rare — the resolver tried 9 numeric suffixes + 2
        // random ones before submit. Surface a friendly retry hint
        // rather than the raw conflict; the user can re-type or wait
        // a beat (e.g. another tab finished creating between resolver
        // and submit) and re-submit.
        setError(
          'That workspace handle just got taken by someone else. Tweak the name and try again.',
        );
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        const msg = body?.message ?? `Failed to create workspace (${res.status})`;
        setError(msg);
        onError?.(msg);
        setSubmitting(false);
        return;
      }

      const data = (await res.json()) as {
        id: string;
        name: string;
        slug: string;
        directives: Record<string, unknown> | null;
      };

      // Land the new space in the cache before any caller navigates into a
      // space-scoped route (SpaceAccessGate 404s on a slug it can't find).
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });

      onCreated({
        id: data.id,
        name: data.name,
        slug: data.slug,
        directives: data.directives ?? null,
      });
    } catch {
      const msg = 'Network error — please try again.';
      setError(msg);
      onError?.(msg);
      setSubmitting(false);
    }
  }, [
    name,
    effectiveSlug,
    description,
    responsibility,
    currentUser,
    headers,
    authFetch,
    queryClient,
    onCreated,
    onError,
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {/* Name */}
      <div>
        <label
          htmlFor="ws-name"
          style={{
            display: 'block',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            marginBottom: 'var(--space-1)',
          }}
        >
          Workspace name
        </label>
        <Input
          ref={nameRef}
          id="ws-name"
          value={name}
          onChange={(e) => {
            handleNameChange(e.target.value);
          }}
          placeholder="e.g. Sales Operations"
          style={{ width: '100%' }}
        />
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-family-mono)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
          }}
        >
          <span>{effectiveSlug || baseSlug || 'workspace-slug'}</span>
          {/* Resolver picked a non-base suffix to dodge a collision —
              tell the user what they're actually getting so the
              workspace handle in the URL isn't a surprise. */}
          {effectiveSlug && baseSlug && effectiveSlug !== baseSlug && (
            <span
              style={{ fontFamily: 'var(--font-family-body)', color: 'var(--color-text-muted)' }}
            >
              {' '}
              — handle adjusted to keep it unique
            </span>
          )}
        </div>
      </div>

      {/* Description */}
      <div>
        <label
          htmlFor="ws-desc"
          style={{
            display: 'block',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-1)',
          }}
        >
          Description{' '}
          <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
        </label>
        <Textarea
          id="ws-desc"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
          placeholder="What is this workspace for?"
          rows={2}
          style={{ width: '100%' }}
        />
      </div>

      {/* Responsibility */}
      <div>
        <label
          htmlFor="ws-responsibility"
          style={{
            display: 'block',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-1)',
          }}
        >
          What will this workspace handle?{' '}
          <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
        </label>
        <Textarea
          id="ws-responsibility"
          value={responsibility}
          onChange={(e) => {
            setResponsibility(e.target.value);
          }}
          placeholder="e.g., Triage support tickets, route to the right team, and track resolution times."
          rows={3}
          style={{ width: '100%' }}
        />
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            lineHeight: 1.5,
          }}
        >
          Your workspace gets a team of AI agents that learn your processes and improve over time.
          You review and approve changes before they take effect.
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          style={{
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-status-failed)',
            background: 'var(--color-status-failed-bg)',
            color: 'var(--color-status-failed)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          {error}
        </div>
      )}

      {/* Submit */}
      <Button
        variant="primary"
        size="lg"
        loading={submitting || slugResolving}
        disabled={!name.trim() || !effectiveSlug.trim() || slugResolving}
        onClick={() => {
          void handleSubmit();
        }}
        style={{ alignSelf: 'stretch' }}
      >
        {submitLabel}
      </Button>
    </div>
  );
}
