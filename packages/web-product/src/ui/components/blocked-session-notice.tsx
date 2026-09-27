/**
 * What the visitor is told when authenticated traffic is blocked.
 *
 * The coordination produced a message from the start and nothing rendered it —
 * every consumer reduced it to a boolean and used that to pause a stream. So a
 * session that could not recover showed the visitor a page that had simply
 * stopped updating, with no statement of why and no way to act.
 *
 * The control appears only where asking would actually do something. An edition
 * with nowhere to send the visitor resolves the same sentence however many times
 * it is asked, and a button that re-derives a message it is already displaying is
 * worse than no button — so `canRetry` carries that, rather than the surface
 * inferring it from recovery having given up.
 */
'use client';

import { Button, Row, Text } from '@aflow/design-system';

import { useApi } from './providers.js';

export function BlockedSessionNotice() {
  const { blockedSession, retrySession } = useApi();
  if (blockedSession === null) return null;

  return (
    <Row
      role="status"
      aria-live="polite"
      align="center"
      justify="between"
      gap="md"
      padding="md"
      style={{
        // The design system's warning ground, which the theme redefines in both
        // directions; a hand-written colour here held one value in both and was
        // unreadable in the light theme. The text keeps its default colour rather
        // than the paired `--color-warning-fg`: measured against this ground the
        // pair returns 3.56:1 in the light theme, under the 4.5:1 floor for text
        // this size, where the default returns 17.4:1 — and 10.9:1 in the dark.
        background: 'var(--color-warning-bg)',
        borderBottom: '1px solid var(--color-warning-default)',
      }}
    >
      <Text size="sm">{blockedSession.message}</Text>
      {blockedSession.canRetry ? (
        <Button size="sm" variant="secondary" onClick={retrySession}>
          Sign in again
        </Button>
      ) : null}
    </Row>
  );
}
