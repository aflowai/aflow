'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Input,
  PageContainer,
  Row,
  Spinner,
  Tab,
  TabList,
  Tabs,
  Text,
} from '@aflow/design-system';
import { AppPageHeader } from '../components/app-page-header.js';
import { useApi } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';

type LifecycleFilter = 'active' | 'archived' | 'all';

interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  archivedAt: string | null;
  myRole: 'admin' | 'editor' | 'viewer' | null;
}

interface PurgePreview {
  spaceId: string;
  name: string;
  slug: string;
  isGeneralSpace: boolean;
  isArchived: boolean;
  perTableCounts: Record<string, number>;
  totalRows: number;
}

export function ArchivedSpacesPage(): ReactElement {
  const { apiUrl, headers } = useApi();
  const router = useRouter();
  const [filter, setFilter] = useState<LifecycleFilter>('archived');
  const [items, setItems] = useState<SpaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInflight, setActionInflight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces?status=${filter}`, {
        headers: headers(),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const body = (await res.json()) as { spaces: SpaceRow[] };
      setItems(body.spaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load spaces');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnarchive = useCallback(
    async (spaceId: string): Promise<void> => {
      setActionInflight(spaceId);
      setActionError(null);
      try {
        const res = await fetch(`${apiUrl}/spaces/${spaceId}/unarchive`, {
          method: 'POST',
          headers: { ...headers(), 'X-Space-ID': spaceId, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            message?: string;
          };
          throw new Error(body.message ?? `HTTP ${String(res.status)}`);
        }
        await load();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Unarchive failed');
      } finally {
        setActionInflight(null);
      }
    },
    [apiUrl, headers, load],
  );

  const handlePurged = useCallback(async () => {
    setPurgeTarget(null);
    await load();
  }, [load]);

  const emptyCopy =
    filter === 'archived'
      ? 'No archived spaces in this tenant. Archived workspaces appear here once an operator archives them via Settings → Danger zone.'
      : filter === 'active'
        ? 'No active spaces match this view.'
        : 'No spaces in this tenant.';

  return (
    <>
      <AppPageHeader
        title="Spaces"
        subtitle="Browse workspaces by lifecycle status. Tenant admins can restore archived spaces, open a space's Danger Zone, or permanently purge an archived space."
      />
      <PageContainer maxWidth={960}>
        <Column gap="md">
          <Tabs
            value={filter}
            onChange={(id) => {
              setFilter(id as LifecycleFilter);
            }}
          >
            <TabList>
              <Tab id="active">Active</Tab>
              <Tab id="archived">Archived</Tab>
              <Tab id="all">All</Tab>
            </TabList>
          </Tabs>

          {error && (
            <Card>
              <CardBody>
                <Text style={{ color: 'var(--color-status-warning)' }}>{error}</Text>
              </CardBody>
            </Card>
          )}

          {actionError && (
            <Card>
              <CardBody>
                <Text style={{ color: 'var(--color-status-danger)' }}>{actionError}</Text>
              </CardBody>
            </Card>
          )}

          {loading && items.length === 0 && (
            <Row justify="center" style={{ padding: 'var(--space-6)' }}>
              <Spinner size="lg" label="Loading spaces" />
            </Row>
          )}

          {!loading && items.length === 0 && !error && (
            <Card>
              <CardBody>
                <Text size="sm" variant="muted">
                  {emptyCopy}
                </Text>
              </CardBody>
            </Card>
          )}

          {items.map((s) => {
            const isArchived = s.archivedAt !== null;
            const isGeneral = s.slug === 'general';
            return (
              <Card key={s.id}>
                <CardBody>
                  <Column gap="sm">
                    <Row gap="md" align="center" wrap>
                      <Column gap="xs" style={{ flex: 1, minWidth: 0 }}>
                        <Row gap="sm" align="center" wrap>
                          <Text size="sm" weight="semibold">
                            {s.name}
                          </Text>
                          <Badge variant="neutral">{s.slug}</Badge>
                          {isArchived && <Badge variant="warning">archived</Badge>}
                          {s.memberCount <= 1 && <Badge variant="info">personal</Badge>}
                        </Row>
                        {isArchived && s.archivedAt && (
                          <Text size="xs" variant="muted">
                            Archived {new Date(s.archivedAt).toLocaleString()}
                          </Text>
                        )}
                      </Column>
                      <Row gap="sm" align="center">
                        {isArchived ? (
                          <>
                            <Button
                              variant="secondary"
                              disabled={actionInflight === s.id}
                              onClick={() => void handleUnarchive(s.id)}
                            >
                              {actionInflight === s.id ? 'Unarchiving…' : 'Unarchive'}
                            </Button>
                            {!isGeneral && (
                              <Button
                                variant="danger"
                                disabled={purgeTarget === s.id}
                                onClick={() => {
                                  setPurgeTarget(s.id);
                                }}
                              >
                                Purge…
                              </Button>
                            )}
                          </>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              router.push(spaceRoute(s.slug, '/settings/danger'));
                            }}
                          >
                            Danger Zone
                          </Button>
                        )}
                      </Row>
                    </Row>

                    {isArchived && !isGeneral && purgeTarget === s.id && (
                      <PurgePanel
                        space={s}
                        onCancel={() => {
                          setPurgeTarget(null);
                        }}
                        onPurged={handlePurged}
                      />
                    )}
                  </Column>
                </CardBody>
              </Card>
            );
          })}
        </Column>
      </PageContainer>
    </>
  );
}

/**
 * Inline name-confirm purge panel for a single archived space. Fetches the
 * blast-radius preview on mount, then gates the irreversible POST behind an
 * exact-name match (GitHub Danger-zone pattern). All endpoints are
 * `allowArchived` and addressed by space id.
 */
function PurgePanel({
  space,
  onCancel,
  onPurged,
}: {
  space: SpaceRow;
  onCancel: () => void;
  onPurged: () => void | Promise<void>;
}): ReactElement {
  const { apiUrl, headers } = useApi();
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [inflight, setInflight] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadError(null);
      try {
        const res = await fetch(`${apiUrl}/spaces/${space.id}/purge-preview`, {
          headers: { ...headers(), 'X-Space-ID': space.id },
        });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = (await res.json()) as PurgePreview;
        if (!cancelled) setPreview(body);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load preview');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, space.id]);

  const handlePurge = useCallback(async () => {
    setInflight(true);
    setPurgeError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${space.id}/purge`, {
        method: 'POST',
        headers: { ...headers(), 'X-Space-ID': space.id, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirm }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        throw new Error(body.message ?? `HTTP ${String(res.status)}`);
      }
      await onPurged();
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : 'Purge failed');
    } finally {
      setInflight(false);
    }
  }, [apiUrl, headers, space.id, confirm, onPurged]);

  const nonZeroTables = preview
    ? Object.entries(preview.perTableCounts)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  // Gate the irreversible POST behind a loaded blast-radius preview: a matching
  // name alone isn't enough — if the preview endpoint is down (loadError) or
  // hasn't returned yet, the operator would be purging blind. Server still
  // re-validates, but the surface must not invite a no-counts purge.
  const canConfirm = preview !== null && loadError === null && confirm === space.name && !inflight;

  return (
    <Card style={{ borderColor: 'var(--color-status-danger)' }}>
      <CardBody>
        <Column gap="sm">
          <Text size="sm" weight="semibold" style={{ color: 'var(--color-status-danger)' }}>
            Permanently delete this space
          </Text>
          <Text size="sm" variant="muted">
            This erases the space and everything in it — sessions, runs, agents, skills, memory, and
            integrations. This cannot be undone.
          </Text>

          {loadError && (
            <Text size="sm" style={{ color: 'var(--color-status-warning)' }}>
              {loadError}
            </Text>
          )}

          {!preview && !loadError && <Spinner size="sm" label="Loading blast radius" />}

          {preview && (
            <Column gap="xs">
              <Text size="sm">
                Will delete <strong>{preview.totalRows.toLocaleString()}</strong> row(s) across{' '}
                <strong>{nonZeroTables.length}</strong> table(s).
              </Text>
              {nonZeroTables.length > 0 && (
                <Text size="xs" variant="muted">
                  {nonZeroTables.map(([table, n]) => `${table} (${String(n)})`).join(', ')}
                </Text>
              )}
            </Column>
          )}

          <Column gap="xs">
            <Text size="sm">
              Type the space name <strong>{space.name}</strong> to confirm:
            </Text>
            <Input
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
              placeholder={space.name}
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </Column>

          {purgeError && (
            <Text size="sm" style={{ color: 'var(--color-status-danger)' }}>
              {purgeError}
            </Text>
          )}

          <Row gap="sm">
            <Button variant="danger" disabled={!canConfirm} onClick={() => void handlePurge()}>
              {inflight ? 'Purging…' : 'Permanently delete'}
            </Button>
            <Button variant="ghost" disabled={inflight} onClick={onCancel}>
              Cancel
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
