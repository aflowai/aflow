'use client';

import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Heading,
  HelperText,
  Input,
  Row,
  Select,
  Text,
} from '@aflow/design-system';
import {
  BROWSER_LOCAL_PORTS_LINE,
  BROWSER_POSTURE_LINES,
  BROWSER_UNATTENDED_LINE,
  type BrowserOriginRule,
  BrowserOriginRuleSchema,
  type BrowserPosture,
  BrowserPostureSchema,
} from '@aflow/schemas';
import { useSpace } from '../providers.js';
import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';

export interface HostBrowserProfile {
  id: string;
  posture: BrowserPosture;
  window: 'hidden' | 'visible';
  spaces: 'all' | string[];
  rules: BrowserOriginRule[];
  unattended: boolean;
  idleMinutes: number;
  /** Every port the policy lists; `refused` says why one this stack serves on stays closed. */
  localPorts: Array<{ port: number; refused?: string }>;
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

interface SettingChange {
  readonly hostname: string;
  readonly profileId: string;
  readonly field: 'posture' | 'unattended' | 'rules' | 'local-ports';
  readonly value: Readonly<Record<string, string>>;
}

/**
 * Posture, `unattended`, origin rules and local ports, changed where they are shown. Each
 * change is a person's request the machine's executor writes into its policy
 * file, as `aflow browser` does; the profile shown after is the inventory the
 * machine republished, so the page shows what is in force. Loosening and
 * tightening are alike: both need a person, and neither asks twice.
 */
export function BrowserProfileSettings({
  hostname,
  profile,
}: {
  readonly hostname: string;
  readonly profile: HostBrowserProfile;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [effect, setEffect] = useState<BrowserOriginRule['effect']>('deny');
  const [port, setPort] = useState('');

  const settled = {
    invalidate: [HOST_STATUS_KEY],
    serialize: ({ hostname: machine, value }: SettingChange) =>
      JSON.stringify({ hostname: machine, ...value }),
    onSuccess: () => {
      setRefusal(null);
    },
    onError: (error: Error) => {
      setRefusal(error.message);
    },
  };
  const set = useApiMutation<SettingChange>({
    path: ({ profileId, field }) => `/host/browsers/${profileId}/${field}`,
    method: 'PUT',
    ...settled,
  });
  const remove = useApiMutation<SettingChange>({
    path: ({ profileId, field }) => `/host/browsers/${profileId}/${field}`,
    method: 'DELETE',
    ...settled,
  });
  const busy = set.isPending || remove.isPending;
  const change = (field: SettingChange['field'], value: Record<string, string>): void => {
    set.mutate({ hostname, profileId: profile.id, field, value });
  };

  return (
    <Column gap="sm">
      <Column gap="xs">
        {BrowserPostureSchema.options.map((posture) => (
          <Row key={posture} gap="sm" align="center">
            <Button
              size="sm"
              variant={profile.posture === posture ? 'primary' : 'secondary'}
              aria-pressed={profile.posture === posture}
              disabled={busy}
              onClick={() => {
                if (profile.posture !== posture) change('posture', { posture });
              }}
            >
              {posture}
            </Button>
            <Text variant="muted" size="sm">
              {BROWSER_POSTURE_LINES[posture]}
            </Text>
          </Row>
        ))}
      </Column>
      <Column gap="xs">
        <Checkbox
          checked={profile.unattended}
          disabled={busy}
          label="Open to runs nobody is present for"
          onChange={(event) => {
            change('unattended', { choice: event.target.checked ? 'allow' : 'refuse' });
          }}
        />
        <HelperText>{BROWSER_UNATTENDED_LINE}</HelperText>
      </Column>
      <Column gap="xs">
        {profile.rules.map((rule) => (
          <Row key={rule.origin} gap="sm" align="center">
            <Text variant="mono" size="sm">
              {rule.effect} {rule.origin}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                remove.mutate({
                  hostname,
                  profileId: profile.id,
                  field: 'rules',
                  value: { origin: rule.origin },
                });
              }}
            >
              Remove
            </Button>
          </Row>
        ))}
        <Row gap="sm" align="center">
          <Input
            aria-label="Origin"
            placeholder="https://mail.example.com or *.example.com"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
            }}
          />
          <Select
            aria-label="Effect"
            value={effect}
            onChange={(event) => {
              setEffect(event.target.value as BrowserOriginRule['effect']);
            }}
          >
            {BrowserOriginRuleSchema.shape.effect.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || origin.trim() === ''}
            onClick={() => {
              set.mutate(
                {
                  hostname,
                  profileId: profile.id,
                  field: 'rules',
                  value: { origin: origin.trim(), effect },
                },
                {
                  onSuccess: () => {
                    setOrigin('');
                  },
                },
              );
            }}
          >
            Add rule
          </Button>
        </Row>
      </Column>
      <Column gap="xs">
        {profile.localPorts.map(({ port: listed, refused }) => (
          <Row key={listed} gap="sm" align="center">
            <Text variant="mono" size="sm">
              localhost:{listed}
            </Text>
            {refused !== undefined && <HelperText>Listed and refused: {refused}</HelperText>}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                remove.mutate({
                  hostname,
                  profileId: profile.id,
                  field: 'local-ports',
                  value: { port: String(listed) },
                });
              }}
            >
              Remove
            </Button>
          </Row>
        ))}
        <Row gap="sm" align="center">
          <Input
            aria-label="Local port"
            inputMode="numeric"
            placeholder="5173"
            value={port}
            onChange={(event) => {
              setPort(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || port.trim() === ''}
            onClick={() => {
              set.mutate(
                {
                  hostname,
                  profileId: profile.id,
                  field: 'local-ports',
                  value: { port: port.trim() },
                },
                {
                  onSuccess: () => {
                    setPort('');
                  },
                },
              );
            }}
          >
            Open port
          </Button>
        </Row>
        <HelperText>{BROWSER_LOCAL_PORTS_LINE}</HelperText>
      </Column>
      {refusal !== null && <HelperText>{refusal}</HelperText>}
    </Column>
  );
}

interface Asked {
  readonly hostname: string;
  readonly profileId: string;
  /** False once the machine has had long enough to open it and has not. */
  readonly waiting: boolean;
}

/**
 * The paired machine's browser profiles. Shown only on the local edition's
 * machine page, inside its edition gate: a profile lives on a paired machine,
 * which the hosted deployment cannot have, and its settings are written by
 * that machine's executor, so no edition without one can change them.
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
                        Stops after {profile.idleMinutes} minutes unused. Open to{' '}
                        {profile.spaces === 'all'
                          ? 'every space'
                          : profile.spaces.map(spaceName).join(', ')}
                        .
                      </Text>
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
                      <BrowserProfileSettings hostname={machine.hostname} profile={profile} />
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
