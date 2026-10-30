'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import { useQuickStartOffer } from '../hooks/use-quick-starts.js';
import {
  joinTemplateNames,
  QUICK_START_OFFER_DECLINED_KEY,
  shouldOfferQuickStarts,
} from '../lib/first-run-offer.js';
import { spaceRoute } from '../lib/space-routes.js';

export interface FirstRunQuickStartCardProps {
  activeSpaceId: string | null | undefined;
  emptyChat: boolean;
}

/**
 * The first-run offer (Plan 334 D1): a card in the empty chat of the empty
 * first space that points at the Store's quick starts. It is not modal and has
 * no close icon, so only Not now declines it. Browse quick starts is not a
 * decline, so a user who comes back with nothing installed sees it again.
 */
export function FirstRunQuickStartCard({ activeSpaceId, emptyChat }: FirstRunQuickStartCardProps) {
  const router = useRouter();
  const offer = useQuickStartOffer();
  // Assumed declined until the browser has been read, so the card never flashes in.
  const [declined, setDeclined] = useState(true);

  useEffect(() => {
    setDeclined(window.localStorage.getItem(QUICK_START_OFFER_DECLINED_KEY) === '1');
  }, []);

  const data = offer.data;
  if (!shouldOfferQuickStarts({ offer: data, activeSpaceId, emptyChat, declined })) return null;
  const emptySpace = data?.emptySpace;
  if (!emptySpace) return null;
  const names = joinTemplateNames(data.templates.map((template) => template.name));

  return (
    <Card style={{ maxWidth: 460, width: '100%', textAlign: 'left' }}>
      <CardBody>
        <Column gap="sm">
          <Text size="sm" weight="semibold">
            Start from a ready-made workspace
          </Text>
          <Text size="sm" variant="muted">
            Quick starts in the Store make a new workspace with the skills and Helmsman directives
            for one kind of work already installed — {names}. {emptySpace.name} stays as it is.
          </Text>
          <Row gap="sm" justify="end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                window.localStorage.setItem(QUICK_START_OFFER_DECLINED_KEY, '1');
                setDeclined(true);
              }}
            >
              Not now
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                router.push(spaceRoute(emptySpace.slug, '/store?kind=quick-start'));
              }}
            >
              Browse quick starts
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
