'use client';

import { useParams } from 'next/navigation';
import { Column } from '@aflow/design-system';
import { AppPageHeader } from '../components/app-page-header.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { AppletInstanceView } from '../components/applet-instance-view.js';

export function AppletInstancePage() {
  const params = useParams<{ space: string; instanceId: string }>();
  const routeSpace = useSpaceFromRoute();
  const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';

  return (
    <Column gap="none" style={{ height: '100%', overflow: 'auto' }}>
      <AppPageHeader title="Applet" />
      <Column gap="md" padding="lg" style={{ maxWidth: 920, width: '100%', margin: '0 auto' }}>
        {instanceId && <AppletInstanceView spaceId={routeSpace?.id} instanceId={instanceId} />}
      </Column>
    </Column>
  );
}
