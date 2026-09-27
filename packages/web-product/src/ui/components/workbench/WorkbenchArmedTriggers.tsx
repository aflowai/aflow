'use client';

import { Column, Row, Text } from '@aflow/design-system';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * Something armed itself to run later, and nobody was asked.
 *
 * Kept out of Needs attention deliberately: that section's badge is a count of
 * work waiting on this person, and an entry that only reports an event would
 * inflate it into a queue nobody can empty. The operator still has to learn
 * that an agent scheduled a run, so it is shown — plainly, next to the section
 * that does claim attention, and it disappears when there is nothing to say.
 */
export function WorkbenchArmedTriggers({
  state,
  spaceSlug,
}: {
  state: UseActionCenterResult;
  spaceSlug: string;
}) {
  const notices = state.lanes.notices;
  if (notices.length === 0) return null;

  return (
    <WorkbenchSection
      title="Recently armed"
      icon="clock"
      link={{ href: `/s/${spaceSlug}/triggers`, label: 'Schedules' }}
    >
      <Column gap="xs">
        {notices.map((item) => (
          <Row key={item.id} gap="sm" align="center">
            <Text size="sm">{item.title}</Text>
            {item.summary ? (
              <Text size="sm" variant="muted">
                {item.summary}
              </Text>
            ) : null}
          </Row>
        ))}
      </Column>
    </WorkbenchSection>
  );
}
