'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Column,
  Dialog,
  Divider,
  Field,
  Heading,
  Icon,
  Input,
  Label,
  Row,
  Select,
  Text,
  Textarea,
} from '@aflow/design-system';
import type { RepoBindingSummary, SaveRepoBindingInput } from '../../hooks/use-repo-bindings.js';
import { nextFreeBindingId } from '../integrations-api/bindingIds.js';

/** An existing GitHub connection a repo can link to (a github `api_bindings` row). */
export interface GithubConnectionOption {
  bindingId: string;
  name: string;
}

/** A connection body the repo form creates via the canonical `POST /bindings` authority. */
interface SaveConnectionInput {
  bindingId: string;
  apiId: string;
  name: string;
  scope: { flowId?: string };
  auth: Record<string, unknown>;
  egressPolicy: Record<string, unknown>;
  enabled?: boolean;
  expectAbsent?: boolean;
}

const ADD_ACCOUNT = '__add_account__';
const DEFAULT_HOST = 'github.com';
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SEG_RE = /^[A-Za-z0-9._-]+$/;

interface ParsedRepo {
  host: string;
  owner: string;
  repo: string;
}

function mk(host: string, owner: string, repo: string): ParsedRepo | null {
  const h = host.trim().toLowerCase();
  const o = owner.trim();
  const r = repo.trim().replace(/\.git$/i, '');
  if (!HOST_RE.test(h) || !SEG_RE.test(o) || !SEG_RE.test(r)) return null;
  return { host: h, owner: o, repo: r };
}

/**
 * Client mirror of `parseRepoCoordinate` — owner/repo (host defaults to github.com),
 * host/owner/repo, or an https remote URL. Used only to validate + suggest egress
 * before the round-trip; the route is the authority.
 */
function parseRepoInput(input: string): ParsedRepo | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
    const segs = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    const [owner, repo] = segs;
    if (owner === undefined || repo === undefined) return null;
    return mk(u.host, owner, repo);
  }
  const parts = s
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  const [first, second, third] = parts;
  if (parts.length === 2 && first !== undefined && second !== undefined) {
    return mk(DEFAULT_HOST, first, second);
  }
  if (first !== undefined && second !== undefined && third !== undefined) {
    return mk(first, second, third);
  }
  return null;
}

/**
 * Client mirror of `branchMatchesAllowed` — used only to block the save before a
 * round-trip; the route is the authority.
 */
function patternMatchesBranch(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  if (pattern.endsWith('/*')) return branch.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return branch.startsWith(pattern.slice(0, -1));
  return false;
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Check-profile commands are one per line — a command may contain commas. */
function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Create/edit a repo designation — the coding lane's authority over one repo,
 * identified by its `owner/repo` coordinate. Lets the operator link an existing
 * GitHub connection OR add a brand-new GitHub account (name + token) inline, so a
 * fresh space is self-serve from this one dialog without bouncing out to
 * /integrations.
 */
export function RepoBindingFormDialog({
  initial,
  connections,
  allGithubBindingIds,
  githubDefinitionExists,
  spaceId,
  onSaveBinding,
  onSaveConnection,
  onSaveCredential,
  onClose,
}: {
  /** When set, edit mode — the repo coordinate is locked (it is the identity). */
  initial?: RepoBindingSummary;
  /** Enabled GitHub connections the repo can link to (the link list). */
  connections: GithubConnectionOption[];
  /** ALL github binding ids incl. disabled — feeds the collision-free next id. */
  allGithubBindingIds: string[];
  /** Whether the github API definition exists — decides POST /bindings vs bootstrap. */
  githubDefinitionExists: boolean;
  spaceId: string;
  onSaveBinding: (body: SaveRepoBindingInput) => Promise<void>;
  /** Create a connection via the canonical `POST /bindings` authority (collision-safe). */
  onSaveConnection: (body: SaveConnectionInput) => Promise<void>;
  /** PUT a credential value under a key — fired when adding a new GitHub account. */
  onSaveCredential: (key: string, value: string, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const editing = Boolean(initial);

  const [repoInput, setRepoInput] = useState(initial?.coordinate ?? '');
  const [defaultBranch, setDefaultBranch] = useState(initial?.defaultBranch ?? 'main');
  const [pushPatterns, setPushPatterns] = useState(
    (initial?.allowedPushBranchPatterns ?? ['agent/*']).join(', '),
  );
  const [description, setDescription] = useState(initial?.description ?? '');
  const [checkProfiles, setCheckProfiles] = useState<Array<{ name: string; commandsText: string }>>(
    (initial?.checkProfiles ?? []).map((p) => ({
      name: p.name,
      commandsText: p.commands.join('\n'),
    })),
  );

  // GitHub connection: link an existing connection, or add a brand-new GitHub
  // account (name + token). A repo resolves git + the github API through its
  // connection.
  const hasConnections = connections.length > 0;
  const [connectionMode, setConnectionMode] = useState<'link' | 'add'>(
    initial?.connectionBindingId !== undefined || hasConnections ? 'link' : 'add',
  );
  const [connectionBindingId, setConnectionBindingId] = useState<string>(
    initial?.connectionBindingId ?? connections[0]?.bindingId ?? '',
  );

  // Add-account mode: a display name + a PAT. The id is derived canonically
  // (github-default/-2/…); the operator's name is the connection's display name.
  const [accountName, setAccountName] = useState('');
  const [accountToken, setAccountToken] = useState('');

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const patterns = useMemo(() => splitList(pushPatterns), [pushPatterns]);
  const defaultBranchConflict = useMemo(
    () => patterns.some((p) => patternMatchesBranch(p, defaultBranch.trim())),
    [patterns, defaultBranch],
  );

  const handleSave = useCallback(async () => {
    setErrorMsg(null);

    const trimmedRepo = repoInput.trim();
    const trimmedBranch = defaultBranch.trim();

    if (!trimmedRepo || !trimmedBranch) {
      setErrorMsg('Repository and default branch are required.');
      return;
    }
    if (!parseRepoInput(trimmedRepo)) {
      setErrorMsg(
        'Repository must be an owner/repo coordinate or a bare https:// URL (e.g. owner/repo or https://github.com/owner/repo.git).',
      );
      return;
    }
    if (patterns.length === 0) {
      setErrorMsg('Add at least one allowed push branch pattern (e.g. agent/*).');
      return;
    }
    if (defaultBranchConflict) {
      setErrorMsg(
        `An allowed push pattern matches the default branch "${trimmedBranch}". The lane may never push to the default branch — restrict the patterns (e.g. agent/*).`,
      );
      return;
    }

    const linking = connectionMode === 'link';
    const trimmedAccountName = accountName.trim();
    const trimmedToken = accountToken.trim();
    if (linking) {
      if (!connectionBindingId) {
        setErrorMsg('Pick a GitHub connection, or add a new GitHub account.');
        return;
      }
    } else if (!trimmedAccountName || !trimmedToken) {
      setErrorMsg('Enter an account name and a token, or pick an existing GitHub connection.');
      return;
    }

    // Operator-authored only: name + commands, both taken verbatim. Incomplete rows
    // (no name or no commands) are dropped; an empty list clears the gate.
    const profiles = checkProfiles
      .map((p) => ({ name: p.name.trim(), commands: splitLines(p.commandsText) }))
      .filter((p) => p.name.length > 0 && p.commands.length > 0);

    const repoFields = {
      repo: trimmedRepo,
      defaultBranch: trimmedBranch,
      allowedPushBranchPatterns: patterns,
      checkProfiles: profiles,
      ...(description.trim() ? { description: description.trim() } : {}),
    };

    try {
      setSaving(true);
      if (linking) {
        await onSaveBinding({ ...repoFields, connectionBindingId });
      } else {
        // Add-account: derive a collision-free canonical id from ALL github
        // bindings (incl. disabled) so neither the credential nor the connection
        // write can clobber a same-id disabled connection.
        const id = nextFreeBindingId('github', allGithubBindingIds);
        const credentialKey = `${id}-token`;
        await onSaveCredential(credentialKey, trimmedToken, trimmedAccountName);
        if (githubDefinitionExists) {
          // The github definition exists (incl. a disabled-only or zero-binding
          // space) ⇒ create the new connection via the canonical collision-safe
          // POST /bindings (preserving the operator's account name), then link the
          // repo to it by id (never the credentialKey).
          await onSaveConnection({
            bindingId: id,
            apiId: 'github',
            name: trimmedAccountName,
            // Composed by the API from the authenticated request; the space is
            // the caller's own and the column is its authority.
            scope: {},
            auth: { type: 'bearer', credentialKey },
            egressPolicy: {},
            enabled: true,
            expectAbsent: true,
          });
          await onSaveBinding({ ...repoFields, connectionBindingId: id });
        } else {
          // No github connection yet ⇒ possibly no github def; the repo route's
          // bootstrap ensures the github definition + mints github-default from the
          // named credential.
          await onSaveBinding({ ...repoFields, credentialKey });
        }
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
      setSaving(false);
    }
  }, [
    repoInput,
    defaultBranch,
    patterns,
    defaultBranchConflict,
    connectionMode,
    connectionBindingId,
    accountName,
    accountToken,
    hasConnections,
    allGithubBindingIds,
    spaceId,
    description,
    checkProfiles,
    onSaveBinding,
    onSaveConnection,
    onSaveCredential,
    onClose,
  ]);

  return (
    <Dialog open onClose={onClose} title={editing ? 'Edit repository' : 'Add repository'}>
      <Column gap="3" style={{ padding: 'var(--space-4)', maxWidth: 600, width: '100%' }}>
        <Text size="sm" color="secondary">
          A repository grants the coding lane authority to clone, branch, and push one repo under a
          fixed branch policy. The token is referenced by name — never stored here.
        </Text>

        <Heading level={5}>Repository</Heading>
        <Field>
          <Label>Repository</Label>
          <Input
            value={repoInput}
            onChange={(e) => {
              setRepoInput(e.target.value);
            }}
            placeholder="owner/repo"
            disabled={editing}
          />
          <Text size="xs" color="muted">
            An <code>owner/repo</code> coordinate (github.com assumed) or a bare https:// URL — no
            embedded credentials. The clone remote is derived from it.
          </Text>
        </Field>

        <Row gap="3">
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Default branch</Label>
              <Input
                value={defaultBranch}
                onChange={(e) => {
                  setDefaultBranch(e.target.value);
                }}
                placeholder="main"
              />
              <Text size="xs" color="muted">
                The lane can never push here.
              </Text>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Allowed push branches</Label>
              <Input
                value={pushPatterns}
                onChange={(e) => {
                  setPushPatterns(e.target.value);
                }}
                placeholder="agent/*"
              />
              <Text size="xs" color="muted">
                Comma-separated globs (e.g. agent/*).
              </Text>
            </Field>
          </div>
        </Row>

        {defaultBranchConflict && (
          <Text size="xs" tone="danger">
            A push pattern matches the default branch — restrict it so the lane can&apos;t push to{' '}
            <strong>{defaultBranch.trim()}</strong>.
          </Text>
        )}

        <Divider />

        {/* === Check profiles — the operator-authored gate the lane runs before accepting a patch === */}
        <Heading level={5}>Check profiles</Heading>
        <Text size="xs" color="muted">
          Operator-authored commands the coding lane runs <strong>before accepting a patch</strong>.
          A profile named <code>default</code> runs on every coding run — a change that fails it is
          not pushed (no red PR). One command per line (e.g. <code>yarn preflight</code>). Leave
          empty to gate nothing.
        </Text>
        {checkProfiles.map((p, i) => (
          <Row key={i} gap="2" align="start">
            <div style={{ flex: '0 0 150px' }}>
              <Field>
                <Label>Name</Label>
                <Input
                  value={p.name}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCheckProfiles((cur) => cur.map((q, j) => (j === i ? { ...q, name: v } : q)));
                  }}
                  placeholder="default"
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field>
                <Label>Commands (one per line)</Label>
                <Textarea
                  value={p.commandsText}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCheckProfiles((cur) =>
                      cur.map((q, j) => (j === i ? { ...q, commandsText: v } : q)),
                    );
                  }}
                  placeholder="yarn preflight"
                  rows={2}
                />
              </Field>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setCheckProfiles((cur) => cur.filter((_, j) => j !== i));
              }}
            >
              Remove
            </Button>
          </Row>
        ))}
        <Row>
          <Button
            variant="ghost"
            onClick={() => {
              setCheckProfiles((cur) => [
                ...cur,
                { name: cur.length === 0 ? 'default' : '', commandsText: '' },
              ]);
            }}
          >
            + Add check profile
          </Button>
        </Row>

        <Divider />

        {/* === GitHub connection === */}
        <Heading level={5}>GitHub connection</Heading>
        <Text size="xs" color="muted">
          A repository resolves both git (clone/push) and the GitHub API (open the PR, post reviews)
          through one connection. Link an existing GitHub connection, or add a new GitHub account.
        </Text>
        <Field>
          <Label>Connection</Label>
          <Select
            value={connectionMode === 'link' ? connectionBindingId || '' : ADD_ACCOUNT}
            onChange={(e) => {
              const v = e.target.value;
              if (v === ADD_ACCOUNT) {
                setConnectionMode('add');
              } else {
                setConnectionMode('link');
                setConnectionBindingId(v);
              }
            }}
          >
            {connections.map((c) => (
              <option key={c.bindingId} value={c.bindingId}>
                {c.name === c.bindingId ? c.bindingId : `${c.name} (${c.bindingId})`}
              </option>
            ))}
            <option value={ADD_ACCOUNT}>+ Add a new GitHub account…</option>
          </Select>
          <Text size="xs" color="muted">
            {hasConnections
              ? 'Reuse a GitHub connection, or add a new GitHub account from a token.'
              : 'No GitHub connection yet — add a new GitHub account below.'}
          </Text>
        </Field>

        {connectionMode === 'add' && (
          <Row gap="3">
            <div style={{ flex: 1 }}>
              <Field>
                <Label>Account name</Label>
                <Input
                  value={accountName}
                  onChange={(e) => {
                    setAccountName(e.target.value);
                  }}
                  placeholder="e.g. work GitHub"
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field>
                <Label>Token (PAT)</Label>
                <Input
                  type="password"
                  value={accountToken}
                  onChange={(e) => {
                    setAccountToken(e.target.value);
                  }}
                  placeholder="ghp_…"
                />
              </Field>
            </div>
          </Row>
        )}

        <Divider />

        <Field>
          <Label>Description (optional)</Label>
          <Textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="What the coding lane uses this repo for."
            rows={2}
          />
        </Field>

        {errorMsg && (
          <Row gap="2" align="start">
            <Badge variant="warning">
              <Icon name="warning-circle" size="xs" />
            </Badge>
            <Text size="sm" tone="danger" style={{ flex: 1 }}>
              {errorMsg}
            </Text>
          </Row>
        )}

        <Row justify="end" gap="2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save repository' : 'Add repository'}
          </Button>
        </Row>
      </Column>
    </Dialog>
  );
}
