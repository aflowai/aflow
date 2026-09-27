'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Card,
  CardBody,
  Column,
  EmptyState,
  FilterChips,
  Icon,
  ListingAvatar,
  PageContainer,
  Row,
  SearchField,
  Spinner,
  Tab,
  TabList,
  Tabs,
  Text,
} from '@aflow/design-system';
import { AppPageHeader } from '../components/app-page-header.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import {
  listingDisplayState,
  useStoreListings,
  type StoreListingSummary,
} from '../hooks/use-store.js';

const KIND_TABS = [
  { id: 'all', label: 'All' },
  { id: 'skill', label: 'Skills' },
  { id: 'integration', label: 'Integrations' },
  { id: 'applet', label: 'Applets' },
] as const;

type ListingKind = 'bundle' | 'connector' | 'applet';

const KIND_LABELS: Record<ListingKind, string> = {
  bundle: 'SKILL',
  connector: 'INTEGRATION',
  applet: 'APPLET',
};

// URL vocabulary is 'skill'/'integration'/'applet'; the API kinds stay
// 'bundle'/'connector'/'applet'.
function parseKind(value: string | null): ListingKind | undefined {
  if (value === 'integration' || value === 'connector') return 'connector';
  if (value === 'applet') return 'applet';
  return value === 'skill' || value === 'bundle' ? 'bundle' : undefined;
}

function kindParam(kind: ListingKind): string {
  if (kind === 'applet') return 'applet';
  return kind === 'connector' ? 'integration' : 'skill';
}

export function StorePage() {
  return (
    <Suspense fallback={null}>
      <StorePageInner />
    </Suspense>
  );
}

function StorePageInner() {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slug ?? '';
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const kind = parseKind(searchParams.get('kind'));
  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category');

  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  // Read the live URL params at fire time — the render-time searchParams
  // captured when the timer was armed would revert a kind/category change
  // made inside the debounce window.
  useEffect(() => {
    if (searchInput === q) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      if (searchInput) next.set('q', searchInput);
      else next.delete('q');
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [searchInput]);

  const listingsQuery = useStoreListings(spaceId, {
    ...(kind ? { kind } : {}),
    ...(q ? { q } : {}),
  });
  const listings = useMemo(() => listingsQuery.data?.listings ?? [], [listingsQuery.data]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const listing of listings) {
      if (listing.category) set.add(listing.category);
    }
    return [...set].sort();
  }, [listings]);

  const filtered = useMemo(
    () => (category ? listings.filter((l) => l.category === category) : listings),
    [listings, category],
  );

  const hasFilters = Boolean(kind || q || category);

  if (!routeSpace) {
    return (
      <>
        <AppPageHeader title="Store" />
        <PageContainer>
          <Row justify="center" style={{ padding: 'var(--space-6)' }}>
            <Spinner size="lg" label="Loading store" />
          </Row>
        </PageContainer>
      </>
    );
  }

  return (
    <>
      <AppPageHeader title="Store" />
      <PageContainer>
        <Column gap="lg">
          <Row justify="between" align="center" wrap gap="2">
            <Tabs
              value={kind ? kindParam(kind) : 'all'}
              onChange={(id) => {
                updateParams({ kind: id === 'all' ? null : id, category: null });
              }}
            >
              <TabList style={{ borderBottom: 'none', marginBottom: 0 }}>
                {KIND_TABS.map((tab) => (
                  <Tab key={tab.id} id={tab.id}>
                    {tab.label}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
            <SearchField
              placeholder="Search the store…"
              value={searchInput}
              onValueChange={setSearchInput}
              style={{ flex: '1 1 220px', maxWidth: 360 }}
            />
          </Row>

          {categories.length > 0 && (
            <FilterChips
              options={categories.map((c) => ({ value: c, label: c }))}
              {...(category ? { value: category } : {})}
              onChange={(value) => {
                updateParams({ category: value === category ? null : value });
              }}
            />
          )}

          {listingsQuery.error && (
            <Card>
              <CardBody>
                <Row gap="sm" align="center">
                  <Icon name="warning" size="sm" />
                  <Text size="sm">{listingsQuery.error.message}</Text>
                </Row>
              </CardBody>
            </Card>
          )}

          {listingsQuery.isLoading && (
            <Row justify="center" style={{ padding: 'var(--space-6)' }}>
              <Spinner size="lg" label="Loading listings" />
            </Row>
          )}

          {!listingsQuery.isLoading && !listingsQuery.error && filtered.length === 0 && (
            <EmptyState
              icon={<Icon name="store" size={48} weight="thin" />}
              title={hasFilters ? 'No matches' : 'Nothing on the shelf yet'}
              description={
                hasFilters
                  ? 'Try a different search, tab, or category.'
                  : 'Skills and integrations will appear here as they are published.'
              }
            />
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 'var(--space-md)',
            }}
          >
            {filtered.map((listing) => (
              <ListingCard
                key={listing.catalogId}
                listing={listing}
                href={spaceRoute(spaceSlug, `/store/${listing.catalogId}`)}
              />
            ))}
          </div>
        </Column>
      </PageContainer>
    </>
  );
}

function ListingCard({ listing, href }: { listing: StoreListingSummary; href: string }) {
  const display = listingDisplayState(listing.installedState);
  return (
    <Link href={href} style={{ textDecoration: 'none', display: 'block' }}>
      <Card interactive>
        <CardBody>
          <Column gap="sm">
            <Row gap="sm" align="center">
              <ListingAvatar
                {...(listing.icon ? { icon: listing.icon } : {})}
                name={listing.name}
                kind={listing.kind}
                seed={listing.catalogId}
                size="lg"
              />
              <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm" weight="semibold" truncate>
                  {listing.name}
                </Text>
                {listing.vendor && (
                  <Text size="xs" variant="muted" truncate>
                    {listing.vendor}
                  </Text>
                )}
              </Column>
            </Row>
            <Text size="xs" variant="muted" style={{ minHeight: 32 }}>
              {listing.tagline}
            </Text>
            <Row gap="xs" align="center" wrap>
              <Badge variant="neutral">{KIND_LABELS[listing.kind]}</Badge>
              {display === 'installed' && <Badge variant="success">Installed</Badge>}
              {display === 'update_available' && <Badge variant="info">Update available</Badge>}
            </Row>
          </Column>
        </CardBody>
      </Card>
    </Link>
  );
}
