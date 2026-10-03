'use client';

import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  HelperText,
  Row,
  Text,
} from '@aflow/design-system';
import type { BrowserOriginRule, BrowserPosture } from '@aflow/schemas';
import { useSpace } from '../providers.js';
import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';

interface HostBrowserProfile {
  id: string;
  posture: BrowserPosture;
  window: 'hidden' | 'visible';
  spaces: 'all' | string[];
  rules: BrowserOriginRule[];
  idleMinutes: number;
  running: boolean;
  windowOpen: boolean;
  sites?: string[];
}

interface HostStatus {
  paired: boolean;
  machines: Array<{ hostname: string; observedAt: string; browsers: HostBrowserProfile[] }>;
}

/** The machine's own state, so tenant-scoped: it is the same machine whichever space is open. */
export const HOST_STATUS_KEY = ['host', 'status'] as const;

/**
 * How often the machine's inventory is read while a window is open or has just
 * been asked for. The machine republishes it as the window opens and closes;
 * nothing pushes it to the page.
 */
const WINDOW_WATCH_MS = 3_000;
/** How long an asked-for window may take to open before the page says it did not. */
const WINDOW_OPEN_WAIT_MS = 60_000;

const CLI = 'yarn workspace @aflow/aflow-executor-host browser';

const POSTURE_LINE: Record<BrowserPosture, string> = {
  autonomous: 'Navigates, reads and acts without asking.',
  'ask-to-act': 'Navigates and reads; every action is refused until asking is built.',
  'read-only': 'Navigates and reads; every action is refused.',
};

interface Asked {
  readonly hostname: string;
  readonly profileId: string;
  /** False once the machine has had long enough to open it and has not. */
  readonly waiting: boolean;
}

/**
 * The paired machine's browser profiles. Shown only on the local edition's
 * machine page, inside its edition gate: a profile lives on a paired machine,
 * which the hosted deployment cannot have.
 */
export function HostBrowserProfiles() {
  const { spaces } = useSpace();
  const [asked, setAsked] = useState<Asked | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const [polling, setPolling] = useState(false);

  const { data } = useApiQuery<HostStatus>({
    key: HOST_STATUS_KEY,
    path: '/host/status',
    ...(polling ? { refetchInterval: WINDOW_WATCH_MS } : {}),
  });
  const shown = data?.machines ?? [];
  const watching =
    asked?.waiting === true ||
    shown.some((machine) => machine.browsers.some((profile) => profile.windowOpen));
  useEffect(() => {
    setPolling(watching);
  }, [watching]);

  const openNow =
    asked === null
      ? false
      : shown.some(
          (machine) =>
            machine.hostname === asked.hostname &&
            machine.browsers.some((b) => b.id === asked.profileId && b.windowOpen),
        );
  useEffect(() => {
    if (asked === null) return;
    if (openNow) {
      setAsked(null);
      return;
    }
    if (!asked.waiting) return;
    const timer = setTimeout(() => {
      setAsked({ ...asked, waiting: false });
    }, WINDOW_OPEN_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [asked, openNow]);

  const signIn = useApiMutation<{ hostname: string; profileId: string }, { asked: true }>({
    path: ({ profileId }) => `/host/browsers/${profileId}/sign-in`,
    serialize: ({ hostname }) => JSON.stringify({ hostname }),
    invalidate: [HOST_STATUS_KEY],
    onSuccess: (_output, { hostname, profileId }) => {
      setRefusal(null);
      setAsked({ hostname, profileId, waiting: true });
    },
    onError: (error) => {
      setRefusal(error.message);
    },
  });

  const spaceName = (id: string): string => spaces.find((s) => s.id === id)?.name ?? id;
  const many = shown.length > 1;

  return (
    <Column gap="sm">
      <Heading level={3}>Browser</Heading>
      <Text variant="muted" size="sm">
        The agent’s own browser on this machine. It reaches the sites you sign in to here, and
        nothing of your everyday browser.
      </Text>
      {refusal !== null && <HelperText>{refusal}</HelperText>}
      {shown.length === 0 ? (
        <Text variant="muted">
          No machine is running its executor, so no browser profile can be shown.
        </Text>
      ) : (
        shown.map((machine) =>
          machine.browsers.length === 0 ? (
            <Text key={machine.hostname} variant="muted">
              {many ? `${machine.hostname}: ` : ''}No browser profile — no supported Chrome was
              found on this machine.
            </Text>
          ) : (
            machine.browsers.map((profile) => {
              const awaited =
                asked !== null &&
                asked.hostname === machine.hostname &&
                asked.profileId === profile.id;
              return (
                <Card key={`${machine.hostname}/${profile.id}`}>
                  <CardBody>
                    <Column gap="sm">
                      <Row justify="between" align="center">
                        <Row gap="sm" align="center">
                          <Text weight="medium">{profile.id}</Text>
                          {many && <Badge variant="neutral">{machine.hostname}</Badge>}
                          <Badge variant={profile.posture === 'autonomous' ? 'warning' : 'neutral'}>
                            {profile.posture}
                          </Badge>
                          <Badge variant="neutral">
                            {profile.window === 'visible' ? 'windowed' : 'headless'}
                          </Badge>
                          {profile.windowOpen ? (
                            <Badge variant="info">window open</Badge>
                          ) : (
                            <Badge variant={profile.running ? 'running' : 'neutral'}>
                              {profile.running ? 'running' : 'stopped'}
                            </Badge>
                          )}
                        </Row>
                        <Button
                          variant="secondary"
                          disabled={
                            profile.windowOpen || (awaited && asked.waiting) || signIn.isPending
                          }
                          onClick={() => {
                            signIn.mutate({ hostname: machine.hostname, profileId: profile.id });
                          }}
                        >
                          Sign in to sites
                        </Button>
                      </Row>
                      <Text variant="muted" size="sm">
                        {POSTURE_LINE[profile.posture]} Stops after {profile.idleMinutes} minutes
                        unused. Open to{' '}
                        {profile.spaces === 'all'
                          ? 'every space'
                          : profile.spaces.map(spaceName).join(', ')}
                        .
                      </Text>
                      {profile.rules.length > 0 && (
                        <Column gap="xs">
                          {profile.rules.map((rule) => (
                            <Text key={rule.origin} variant="mono" size="sm">
                              {rule.effect} {rule.origin}
                            </Text>
                          ))}
                        </Column>
                      )}
                      {profile.windowOpen ? (
                        <Text size="sm">
                          The window is open on {machine.hostname}. Sign in to every site the agent
                          should reach, in as many tabs as you like, then close it. Runs using this
                          profile wait until you do.
                        </Text>
                      ) : awaited && asked.waiting ? (
                        <Text size="sm">Opening the window on {machine.hostname}…</Text>
                      ) : awaited ? (
                        <HelperText>
                          The window did not open on {machine.hostname}. The executor’s log there
                          says why.
                        </HelperText>
                      ) : profile.running ? (
                        <Text variant="muted" size="sm">
                          {profile.sites !== undefined && profile.sites.length > 0
                            ? `Sites that hold a session: ${profile.sites.join(', ')}.`
                            : 'No site holds a session in it.'}
                        </Text>
                      ) : (
                        <Text variant="muted" size="sm">
                          Which sites hold a session shows while its browser runs.
                        </Text>
                      )}
                      <HelperText>
                        Posture and rules change on the machine only:{' '}
                        <Text variant="mono" size="sm">
                          {CLI} posture {profile.id} &lt;autonomous|ask-to-act|read-only&gt;
                        </Text>{' '}
                        and{' '}
                        <Text variant="mono" size="sm">
                          {CLI} rule {profile.id} &lt;origin&gt; &lt;allow|ask|deny&gt;
                        </Text>
                        .
                      </HelperText>
                    </Column>
                  </CardBody>
                </Card>
              );
            })
          ),
        )
      )}
    </Column>
  );
}
