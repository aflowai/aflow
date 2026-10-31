'use client';

import { useState } from 'react';
import { Button, Column, HelperText, Input, Row, Text, Textarea } from '@aflow/design-system';
import {
  declareFolderPreviewCommand,
  FOLDER_PREVIEW_PORT_PLACEHOLDER,
  FOLDER_PREVIEW_READY_WITHIN_DEFAULT_SECONDS,
  FOLDER_PREVIEW_READY_WITHIN_MAX_SECONDS,
  type HostFolderPreview,
  HostFolderPreviewSchema,
  resolveFolderPreview,
  zodIssueMessage,
} from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';

/** A folder's preview as the bindings listing carries it from the machine holding the folder. */
export interface FolderPreviewListing {
  hostname: string;
  declared: HostFolderPreview | null;
  detectedWebApps: string[];
}

interface PreviewChange {
  readonly preview: HostFolderPreview | null;
}

export const PREVIEW_NOT_DECLARED = 'Preview not declared';

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

interface Draft {
  command: string;
  port: string;
  readyPath: string;
  readyWithinSeconds: string;
  uiPaths: string;
  webAppDirs: string;
}

function draftOf(declared: HostFolderPreview | null): Draft {
  return {
    command: declared?.command ?? '',
    port: declared?.port === undefined ? '' : String(declared.port),
    readyPath: declared?.readyPath ?? '',
    readyWithinSeconds:
      declared?.readyWithinSeconds === undefined ? '' : String(declared.readyWithinSeconds),
    uiPaths: (declared?.uiPaths ?? []).join('\n'),
    webAppDirs: (declared?.webAppDirs ?? []).join('\n'),
  };
}

/** The draft as a declaration, or the first reason the shared schema refuses it. */
export function previewFromDraft(
  draft: Draft,
): { ok: true; preview: HostFolderPreview } | { ok: false; reason: string } {
  const port = draft.port.trim();
  if (port !== '' && !/^\d{1,5}$/.test(port)) {
    return { ok: false, reason: `'${port}' is not a port: give a whole number from 1 to 65535.` };
  }
  const readyWithin = draft.readyWithinSeconds.trim();
  if (readyWithin !== '' && !/^\d{1,9}$/.test(readyWithin)) {
    return {
      ok: false,
      reason:
        `'${readyWithin}' is not a number of seconds: give a whole number from 1 to ` +
        `${String(FOLDER_PREVIEW_READY_WITHIN_MAX_SECONDS)}.`,
    };
  }
  const uiPaths = lines(draft.uiPaths);
  const webAppDirs = lines(draft.webAppDirs);
  const parsed = HostFolderPreviewSchema.safeParse({
    command: draft.command,
    ...(port !== '' ? { port: Number(port) } : {}),
    ...(draft.readyPath.trim() !== '' ? { readyPath: draft.readyPath.trim() } : {}),
    ...(readyWithin !== '' ? { readyWithinSeconds: Number(readyWithin) } : {}),
    ...(uiPaths.length > 0 ? { uiPaths } : {}),
    ...(webAppDirs.length > 0 ? { webAppDirs } : {}),
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return { ok: false, reason: issue === undefined ? 'Not a preview.' : zodIssueMessage(issue) };
  }
  return { ok: true, preview: parsed.data };
}

/**
 * A connected folder's preview on the machine page (Plan 320 D18): how its
 * change is seen working, as the machine holding it declares, and the form a
 * person declares or clears it with. Each change is relayed to that machine's
 * executor, which writes it as `aflow folder <id> preview` does; the folder
 * shown after is what the machine republished.
 */
export function HostFolderPreview({
  spaceId,
  bindingId,
  allowsExecution,
  listing,
}: {
  readonly spaceId: string;
  readonly bindingId: string;
  readonly allowsExecution: boolean;
  readonly listing: FolderPreviewListing | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(listing?.declared ?? null));
  const [refusal, setRefusal] = useState<string | null>(null);

  const settled = {
    invalidate: [['space', spaceId, 'hostBindings'] as const],
    onSuccess: () => {
      setRefusal(null);
      setEditing(false);
    },
    onError: (error: Error) => {
      setRefusal(error.message);
    },
  };
  const hostname = listing?.hostname ?? '';
  const serialize = ({ preview }: PreviewChange): string =>
    JSON.stringify(preview === null ? { hostname } : { hostname, preview });
  const declare = useApiMutation<PreviewChange>({
    path: () => `/host/folders/${bindingId}/preview`,
    method: 'PUT',
    spaceId,
    serialize,
    ...settled,
  });
  const clear = useApiMutation<PreviewChange>({
    path: () => `/host/folders/${bindingId}/preview`,
    method: 'DELETE',
    spaceId,
    serialize,
    ...settled,
  });
  const busy = declare.isPending || clear.isPending;

  // No machine holding the folder is running, so there is nothing to show or ask.
  if (listing === null) return null;
  const { declared, detectedWebApps } = listing;
  if (declared === null && !allowsExecution) return null;

  const field = (name: keyof Draft) => ({
    value: draft[name],
    onChange: (event: { target: { value: string } }) => {
      setDraft({ ...draft, [name]: event.target.value });
    },
  });

  const summary =
    declared === null ? (
      detectedWebApps.length > 0 ? (
        <Column gap="xs">
          <Text size="sm" weight="medium">
            {PREVIEW_NOT_DECLARED}
          </Text>
          <Text variant="muted" size="sm">
            The machine found a web app in {detectedWebApps.join(', ')}. Declare how it is served
            and a change to its UI can be seen working before it merges. Until then, a review of a
            change to it reads it as a diff and says so as a needs_setup finding.
          </Text>
          <Text variant="muted" size="sm">
            On the machine:{' '}
            <Text variant="mono" size="sm">
              {declareFolderPreviewCommand(bindingId)}
            </Text>
          </Text>
        </Column>
      ) : null
    ) : (
      <DeclaredPreview preview={declared} />
    );

  return (
    <Column gap="xs">
      {summary}
      {editing ? (
        <Column gap="xs">
          <Input
            aria-label="Preview command"
            placeholder={`yarn dev --port ${FOLDER_PREVIEW_PORT_PLACEHOLDER}`}
            {...field('command')}
          />
          <Row gap="sm" align="center">
            <Input
              aria-label="Preview port"
              inputMode="numeric"
              placeholder="free port"
              {...field('port')}
            />
            <Input aria-label="Ready path" placeholder="/" {...field('readyPath')} />
            <Input
              aria-label="Ready within seconds"
              inputMode="numeric"
              placeholder={`${String(FOLDER_PREVIEW_READY_WITHIN_DEFAULT_SECONDS)} s`}
              {...field('readyWithinSeconds')}
            />
          </Row>
          <Textarea
            aria-label="UI paths"
            rows={3}
            placeholder="One glob per line. Empty: the default UI files."
            {...field('uiPaths')}
          />
          <Textarea
            aria-label="Web app directories"
            rows={2}
            placeholder={
              detectedWebApps.length > 0
                ? `One directory per line, such as ${detectedWebApps[0] ?? ''}`
                : 'One directory per line, such as apps/web'
            }
            {...field('webAppDirs')}
          />
          <HelperText>
            The command runs from the root of a run’s checkout, with{' '}
            {FOLDER_PREVIEW_PORT_PLACEHOLDER} where its port goes. Leave the port empty and each run
            takes a free one; a fixed port serves one run at a time, and a port Aflow serves on is
            refused. Ready within is how many seconds the ready path may take to answer:{' '}
            {FOLDER_PREVIEW_READY_WITHIN_DEFAULT_SECONDS} when empty, at most{' '}
            {FOLDER_PREVIEW_READY_WITHIN_MAX_SECONDS}. Saving replaces the declaration before;
            nothing is started now.
          </HelperText>
          <Row gap="sm" align="center">
            <Button
              size="sm"
              disabled={busy || draft.command.trim() === ''}
              onClick={() => {
                const built = previewFromDraft(draft);
                if (!built.ok) {
                  setRefusal(built.reason);
                  return;
                }
                declare.mutate({ preview: built.preview });
              }}
            >
              Save preview
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          </Row>
        </Column>
      ) : (
        <Row gap="sm" align="center">
          {allowsExecution && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(draftOf(declared));
                setEditing(true);
              }}
            >
              {declared === null ? 'Declare preview' : 'Change preview'}
            </Button>
          )}
          {declared !== null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                clear.mutate({ preview: null });
              }}
            >
              Clear preview
            </Button>
          )}
        </Row>
      )}
      {refusal !== null && <HelperText>{refusal}</HelperText>}
    </Column>
  );
}

function DeclaredPreview({ preview }: { readonly preview: HostFolderPreview }) {
  const resolved = resolveFolderPreview(preview);
  const byDefault = (given: unknown): string => (given === undefined ? ' (default)' : '');
  return (
    <Column gap="xs">
      <Text variant="muted" size="sm">
        Preview:{' '}
        <Text variant="mono" size="sm">
          {resolved.command}
        </Text>
      </Text>
      <Text variant="muted" size="sm">
        Port: {resolved.port === undefined ? 'free port, a new one each run' : resolved.port}
        {' · '}Ready at {resolved.readyPath}
        {byDefault(preview.readyPath)}
        {' · '}Within {resolved.readyWithinSeconds} s{byDefault(preview.readyWithinSeconds)}
      </Text>
      <Text variant="muted" size="sm">
        UI files{byDefault(preview.uiPaths)}: {resolved.uiPaths.join(', ')}
      </Text>
    </Column>
  );
}
