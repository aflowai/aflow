'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageContainer, Row, Text } from '@aflow/design-system';
import { AppPageHeader } from '../components/app-page-header.js';
import { TabNav } from '../TabNav.js';
import { useCurrentUser } from '../components/user-avatar.js';
import { useEdition } from '../hooks/useEdition.js';
import { visibleSettingsTabs } from '../components/tenant-settings/tabs.js';

export function TenantSettingsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const edition = useEdition();

  const tabs = visibleSettingsTabs({ edition, isOwner: currentUser?.isOwner ?? false });

  const isLoading = currentUser === null;
  const isAdmin = currentUser?.isAdmin ?? false;

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      router.replace('/account');
    }
  }, [isLoading, isAdmin, router]);

  if (isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            Loading...
          </Text>
        </Row>
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return null;
  }

  return (
    <>
      <AppPageHeader
        title={edition.id === 'enterprise' ? 'Tenant Admin' : 'Settings'}
        showSpace={false}
        tabs={<TabNav tabs={tabs} />}
      />
      {children}
    </>
  );
}
