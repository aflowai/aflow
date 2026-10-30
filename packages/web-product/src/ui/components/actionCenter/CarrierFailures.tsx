'use client';
import { Button, Card, CardBody, Column, Text } from '@aflow/design-system';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
export function CarrierFailures({ state }: { state: UseActionCenterResult }) {
  if (!state.carrierFailures?.length) return null;
  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          <div role="alert">
            {state.carrierFailures.map((failure, index) => (
              <Text key={index} size="sm" style={{ color: 'var(--color-warning-default)' }}>
                {failure}
              </Text>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={state.clearCarrierFailures}>
            Dismiss
          </Button>
        </Column>
      </CardBody>
    </Card>
  );
}
