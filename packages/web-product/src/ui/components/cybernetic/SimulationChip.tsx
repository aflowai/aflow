'use client';

import Link from 'next/link';
import {
  Column,
  Icon,
  MenuItem,
  Popover,
  Row,
  Text,
  ToggleChip,
  Tooltip,
} from '@aflow/design-system';
import { useSimulation } from '../../hooks/use-simulations.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { NOBODY_PERSONA } from '../../lib/rehearsal.js';
import type { AgentSettingsVariant } from './AgentSettingsPopover.js';

const PANEL_WIDTH = 320;

/**
 * What this chat is standing in front of, when it was opened as a rehearsal.
 *
 * The persona's NAME is read from the artifact rather than carried in the link.
 * A display name in a URL is a copy, and the copy goes stale the moment someone
 * renames a persona — so the link carries the id, which is what identifies the
 * rows, and the name is resolved from the simulation that declares it.
 *
 * The query is keyed exactly as the simulation page's, so arriving from the
 * Rehearse panel is a cache hit. It is disabled outright when there is no
 * simulation in the URL, which is every ordinary chat.
 */
export function SimulationChip({
  spaceId,
  spaceSlug,
  simulationId,
  personaId,
  baselineVersion,
  open,
  onOpenChange,
  variant = 'chip',
}: {
  spaceId: string;
  spaceSlug: string | undefined;
  simulationId: string;
  personaId: string;
  baselineVersion: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: AgentSettingsVariant;
}) {
  const { summary, simulation } = useSimulation(spaceId, simulationId);

  const isNobody = personaId === NOBODY_PERSONA;
  const persona = (() => {
    if (isNobody) return null;
    const declared = (simulation as { personas?: unknown } | null)?.personas;
    if (!Array.isArray(declared)) return null;
    return (
      (declared as Array<{ personaId?: unknown; label?: unknown }>).find(
        (candidate) => candidate.personaId === personaId,
      ) ?? null
    );
  })();

  const label = isNobody
    ? 'Not signed in'
    : typeof persona?.label === 'string' && persona.label.length > 0
      ? persona.label
      : personaId;

  const worldHref = spaceSlug
    ? spaceRoute(spaceSlug, `/integrations/simulations/${encodeURIComponent(simulationId)}`)
    : null;

  // The chip shows WHO, the tooltip says WHAT KIND. Putting both in one string
  // gave "Simulated — Faisal — Jeddah", which reads as one long name.
  const tooltip = 'Simulated — answers come from an authored world, not a real service';
  const ariaLabel = `Simulated, acting as ${label}`;

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      placement="top-start"
      width={PANEL_WIDTH}
      aria-label="Simulation"
      trigger={({ ref, open: isOpen, toggle }) =>
        variant === 'menu-item' ? (
          <MenuItem
            ref={ref}
            active={isOpen}
            icon={<Icon name="flask" size="sm" />}
            label={`Simulated — ${label}`}
            trailing={<Icon name="caret-right" size="xs" />}
            onClick={toggle}
            aria-expanded={isOpen}
            aria-label={ariaLabel}
          />
        ) : (
          <div ref={ref} style={{ display: 'inline-flex' }}>
            <Tooltip content={tooltip}>
              <ToggleChip
                active={isOpen}
                icon={<Icon name="flask" size="xs" />}
                onClick={toggle}
                aria-label={ariaLabel}
              >
                {label}
              </ToggleChip>
            </Tooltip>
          </div>
        )
      }
    >
      {() => (
        <>
          <Row align="center" gap="2" style={{ marginBottom: 'var(--space-2)' }}>
            <Icon name="flask" size="sm" />
            <Text size="sm" weight="semibold">
              Simulated
            </Text>
          </Row>

          <Text
            size="xs"
            variant="muted"
            style={{ display: 'block', marginBottom: 'var(--space-2)' }}
          >
            Nothing here reaches a real service. The answers come from an authored world, and this
            conversation is pinned to it for its whole life.
          </Text>

          <Column gap="1">
            <DetailRow label="Integration" value={summary?.name ?? simulationId} />
            <DetailRow label="Acting as" value={label} {...(isNobody ? {} : { hint: personaId })} />
            <DetailRow label="World" value={baselineVersion ? `v${baselineVersion}` : 'Latest'} />
          </Column>

          {worldHref && (
            <Column gap="xs" style={{ marginTop: 'var(--space-3)' }}>
              <Link href={worldHref} style={{ textDecoration: 'none' }}>
                <Row align="center" gap="1">
                  <Icon name="database" size="xs" />
                  <Text size="xs">Open the world inspector</Text>
                  <Icon name="arrow-right" size="xs" />
                </Row>
              </Link>
              <Text size="xs" variant="muted">
                Every row this conversation can read, and what it changed.
              </Text>
            </Column>
          )}
        </>
      )}
    </Popover>
  );
}

function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Row align="baseline" justify="between" gap="2">
      <Text size="xs" variant="muted">
        {label}
      </Text>
      <Row align="baseline" gap="1" style={{ minWidth: 0 }}>
        <Text size="xs" weight="medium">
          {value}
        </Text>
        {hint && (
          <Text size="xs" variant="muted">
            {hint}
          </Text>
        )}
      </Row>
    </Row>
  );
}
