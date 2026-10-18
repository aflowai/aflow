'use client';

import {
  Badge,
  Card,
  CardBody,
  Column,
  Field,
  Heading,
  HelperText,
  Label,
  Row,
  Select,
  Text,
} from '@aflow/design-system';
import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';

export interface SpaceHostMachine {
  hostname: string;
  harnesses: Array<{ id: string; label?: string; installed: boolean }>;
  defaultHarness?: string;
}

interface PreferredHarnessResponse {
  preferredHarness: string | null;
}

interface HarnessChoice {
  id: string;
  label: string;
  /** Machines holding this space's folders that can start it. */
  installedOn: number;
}

/** Every harness any machine offers, by id, with how many can start it. */
export function harnessChoices(machines: readonly SpaceHostMachine[]): HarnessChoice[] {
  const byId = new Map<string, HarnessChoice>();
  for (const machine of machines) {
    for (const harness of machine.harnesses) {
      const known = byId.get(harness.id) ?? {
        id: harness.id,
        label: harness.label ?? harness.id,
        installedOn: 0,
      };
      if (harness.label !== undefined) known.label = harness.label;
      if (harness.installed) known.installedOn += 1;
      byId.set(harness.id, known);
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function describeAvailability(choice: HarnessChoice, machineCount: number): string {
  if (choice.installedOn === 0) {
    return machineCount === 1 ? 'not installed on this computer' : 'not installed on any machine';
  }
  if (machineCount === 1) return 'installed';
  return `installed on ${String(choice.installedOn)} of ${String(machineCount)} machines`;
}

const preferredHarnessKey = (spaceId: string) => ['space', spaceId, 'preferredHarness'] as const;

/**
 * The coding agent this space prefers (Plan 326 D12). The machine decides what
 * it runs — a preference it has not installed falls back to its own default and
 * the run says so — so the choices are what the machines publish, each marked
 * with whether it can start there.
 */
export function HostCodingAgent({
  spaceId,
  machines,
}: {
  spaceId: string;
  machines: readonly SpaceHostMachine[];
}) {
  const key = preferredHarnessKey(spaceId);
  const { data } = useApiQuery<PreferredHarnessResponse>({
    key,
    path: `/spaces/${spaceId}/preferred-harness`,
    enabled: spaceId.length > 0,
  });
  const save = useApiMutation<string | null>({
    path: () => `/spaces/${spaceId}/preferred-harness`,
    method: 'PUT',
    serialize: (preferredHarness) => JSON.stringify({ preferredHarness }),
    spaceId,
    invalidate: [key],
  });

  const preferred = data?.preferredHarness ?? null;
  const choices = harnessChoices(machines);
  const offered = preferred === null || choices.some((choice) => choice.id === preferred);

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Heading level={3}>Coding agent</Heading>
          <Text variant="muted" size="sm">
            The coding agent a task runs when it names none. A machine that does not have it
            installed runs its own default, and the run says which one ran. A task can still name a
            different one.
          </Text>
          {machines.length === 0 ? (
            <HelperText>
              No machine holding this workspace&apos;s folders is running, so there is nothing to
              choose from yet.
            </HelperText>
          ) : (
            <Field>
              <Label>Preferred coding agent</Label>
              <Select
                value={preferred ?? ''}
                disabled={save.isPending}
                onChange={(e) => {
                  void save.mutateAsync(e.target.value === '' ? null : e.target.value);
                }}
              >
                <option value="">Each machine&apos;s default</option>
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label} — {describeAvailability(choice, machines.length)}
                  </option>
                ))}
                {!offered && preferred !== null && (
                  <option value={preferred}>{preferred} — not offered by any machine</option>
                )}
              </Select>
            </Field>
          )}
          {machines.map((machine) => (
            <Row key={machine.hostname} gap="sm" align="center" wrap>
              <Text size="sm" weight="medium">
                {machine.hostname}
              </Text>
              {machine.harnesses.map((harness) => (
                <Badge key={harness.id} variant={harness.installed ? 'success' : 'neutral'}>
                  {harness.label ?? harness.id}
                  {harness.id === machine.defaultHarness ? ' · default' : ''}
                  {harness.installed ? '' : ' · not installed'}
                </Badge>
              ))}
              {machine.harnesses.length === 0 && (
                <Text variant="muted" size="sm">
                  offers no coding agent yet — add one on that machine
                </Text>
              )}
            </Row>
          ))}
        </Column>
      </CardBody>
    </Card>
  );
}
