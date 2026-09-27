'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Card,
  CardBody,
  Checkbox,
  Column,
  Heading,
  ListingAvatar,
  PageContainer,
  Row,
  SearchField,
  Spinner,
  Text,
} from '@aflow/design-system';
import type { StoreListingAvailability } from '@aflow/schemas';
import {
  useAdminStoreCatalog,
  useRemoveStoreOverride,
  useSetStoreOverride,
  useSetStorePolicy,
  useStoreOverrides,
  useStorePolicy,
  type StoreCatalogListing,
} from '../hooks/use-tenant-governance.js';
import {
  ErrorRow,
  ModeToggle,
  SectionDivider,
} from '../components/tenant-settings/policy-controls.js';

const KIND_LABELS: Record<StoreCatalogListing['kind'], string> = {
  bundle: 'Skill',
  connector: 'Integration',
  applet: 'Applet',
};

export function TenantStorePolicyPage() {
  const storePolicyQuery = useStorePolicy();
  const setStorePolicy = useSetStorePolicy();
  const overridesQuery = useStoreOverrides();
  const setOverride = useSetStoreOverride();
  const removeOverride = useRemoveStoreOverride();
  const catalogQuery = useAdminStoreCatalog();

  const [query, setQuery] = useState('');

  const defaultAvailability = storePolicyQuery.data?.defaultAvailability;
  const overrideByCatalogId = useMemo(
    () => new Map((overridesQuery.data?.overrides ?? []).map((o) => [o.catalogId, o.availability])),
    [overridesQuery.data],
  );

  const listings = useMemo(() => {
    const all = [...(catalogQuery.data?.listings ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (listing) => listing.name.toLowerCase().includes(q) || listing.catalogId.includes(q),
    );
  }, [catalogQuery.data, query]);

  const toggle = (listing: StoreCatalogListing, available: boolean) => {
    if (defaultAvailability === undefined) return;
    const next: StoreListingAvailability = available ? 'available' : 'hidden';
    if (next === defaultAvailability) {
      if (overrideByCatalogId.has(listing.catalogId)) {
        removeOverride.mutate({ catalogId: listing.catalogId });
      }
      return;
    }
    setOverride.mutate({ catalogId: listing.catalogId, availability: next });
  };

  if (storePolicyQuery.isLoading || catalogQuery.isLoading || overridesQuery.isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Spinner size="lg" label="Loading store settings" />
        </Row>
      </PageContainer>
    );
  }

  const mutating = setOverride.isPending || removeOverride.isPending;
  const mutationError = setOverride.error ?? removeOverride.error;

  return (
    <PageContainer>
      <Column gap="lg">
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Store</Heading>
              <Text size="xs" variant="muted">
                Decides which Store listings exist for this tenant. Hiding a listing blocks new
                installs only — spaces that already installed it keep it and can still update or
                uninstall.
              </Text>
            </Column>

            {storePolicyQuery.error && <ErrorRow message={storePolicyQuery.error.message} />}

            <ModeToggle
              options={[
                {
                  value: 'available' as const,
                  label: 'Available by default',
                  description: 'Every listing is on the shelf unless you turn it off below.',
                },
                {
                  value: 'hidden' as const,
                  label: 'Hidden by default',
                  description: 'The shelf starts empty. Only listings you turn on below appear.',
                },
              ]}
              value={defaultAvailability}
              disabled={storePolicyQuery.isLoading || setStorePolicy.isPending}
              onSelect={(value) => {
                setStorePolicy.mutate({ defaultAvailability: value });
              }}
            />
            {setStorePolicy.error && <ErrorRow message={setStorePolicy.error.message} />}
          </Column>
        </section>

        <section>
          <Column gap="md">
            <Row justify="between" align="center" wrap gap="2">
              <Text size="sm" weight="medium">
                Listings
              </Text>
              <SearchField
                placeholder="Filter listings…"
                value={query}
                onValueChange={setQuery}
                style={{ width: 240 }}
              />
            </Row>

            {catalogQuery.error && <ErrorRow message={catalogQuery.error.message} />}
            {overridesQuery.error && <ErrorRow message={overridesQuery.error.message} />}
            {mutationError && <ErrorRow message={mutationError.message} />}

            <Card>
              <CardBody>
                <Column gap="sm">
                  {listings.map((listing, index) => {
                    const override = overrideByCatalogId.get(listing.catalogId);
                    const available = (override ?? defaultAvailability) === 'available';
                    return (
                      <Column key={listing.catalogId} gap="xs">
                        <Row gap="sm" align="center" justify="between">
                          <Row gap="sm" align="center" style={{ minWidth: 0, flex: 1 }}>
                            <ListingAvatar
                              {...(listing.icon ? { icon: listing.icon } : {})}
                              name={listing.name}
                              kind={listing.kind}
                              seed={listing.catalogId}
                              size="sm"
                            />
                            <Column gap="0" style={{ minWidth: 0 }}>
                              <Text size="sm" weight="medium" truncate>
                                {listing.name}
                              </Text>
                              <Text size="xs" variant="muted" truncate>
                                {listing.tagline}
                              </Text>
                            </Column>
                          </Row>
                          <Row gap="sm" align="center">
                            <Badge variant="neutral">{KIND_LABELS[listing.kind]}</Badge>
                            <Text size="xs" variant="muted">
                              v{String(listing.version)}
                            </Text>
                            <Checkbox
                              checked={available}
                              disabled={mutating || defaultAvailability === undefined}
                              aria-label={`${listing.name} available in the Store`}
                              onChange={(e) => {
                                toggle(listing, e.target.checked);
                              }}
                            />
                          </Row>
                        </Row>
                        {index < listings.length - 1 && <SectionDivider />}
                      </Column>
                    );
                  })}
                  {listings.length === 0 && (
                    <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                      No matching listings.
                    </Text>
                  )}
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
