import type { SkillBundleInput } from '@aflow/schemas';
import { TICKER_DIGEST_DATA_SCHEMA } from '../skillCatalog/tickerMarketDigestShape.js';

type BundleArtifactSeedInput = NonNullable<SkillBundleInput['artifactSeed']>[number];

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion (guard-tested against the compact contract);
// 'fallback' marks the hash slot as intentionally unpinned.
const TICKER_DIGEST_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

const DIGEST_CARD_TSX = `
import React from 'react';
import { Card, Column, Row, Section, Heading, Text, Badge, Panel, Divider } from '@aflow/design-system';

export default function TickerDigestCard({ data }) {
  const summary = data?.priceSummary ?? {};
  const bars = Array.isArray(data?.bars) ? data.bars : [];
  const news = Array.isArray(data?.news) ? data.news : [];
  const watchItems = Array.isArray(data?.watchItems) ? data.watchItems : [];

  const fmtUsd = (n) => typeof n === 'number'
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    : '—';
  const fmtPct = (n) => typeof n === 'number'
    ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
    : '—';
  const fmtVol = (n) => typeof n === 'number'
    ? n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n.toLocaleString('en-US')
    : '—';
  const trendColor = (n) => (typeof n === 'number' && n < 0) ? 'var(--ds-danger)' : 'var(--ds-success)';

  const closes = bars.map((b) => (typeof b.close === 'number' ? b.close : null)).filter((c) => c !== null);
  const minClose = closes.length ? Math.min(...closes) : 0;
  const maxClose = closes.length ? Math.max(...closes) : 1;
  const span = maxClose - minClose || 1;

  return (
    <Card elevated padding="lg">
      <Column gap="md">
        <Row justify="space-between" align="center" wrap>
          <Column gap="xs">
            <Heading level={3}>{data?.ticker} · {data?.companyName}</Heading>
            <Text size="sm" color="muted">As of {data?.asOf}{data?.focus ? ' — focus: ' + data.focus : ''}</Text>
          </Column>
          <Row gap="sm" align="center">
            <Heading level={3}>{fmtUsd(summary.lastClose)}</Heading>
            <Badge variant={typeof summary.changePct1d === 'number' && summary.changePct1d < 0 ? 'danger' : 'success'}>
              {fmtPct(summary.changePct1d)}
            </Badge>
          </Row>
        </Row>

        <Row gap="lg" wrap>
          <Panel padding="md" variant="elevated">
            <Column gap="xs">
              <Text size="sm" color="muted">30d change</Text>
              <Heading level={4}>
                <span style={{ color: trendColor(summary.changePct30d) }}>{fmtPct(summary.changePct30d)}</span>
              </Heading>
            </Column>
          </Panel>
          <Panel padding="md" variant="elevated">
            <Column gap="xs">
              <Text size="sm" color="muted">30d high / low</Text>
              <Heading level={4}>{fmtUsd(summary.high30d)} / {fmtUsd(summary.low30d)}</Heading>
            </Column>
          </Panel>
          <Panel padding="md" variant="elevated">
            <Column gap="xs">
              <Text size="sm" color="muted">Avg volume (30d)</Text>
              <Heading level={4}>{fmtVol(summary.avgVolume30d)}</Heading>
            </Column>
          </Panel>
        </Row>

        {bars.length > 0 && (
          <Section title="Trend (daily closes)">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '64px' }}>
              {bars.map((b, idx) => {
                const h = typeof b.close === 'number' ? 8 + ((b.close - minClose) / span) * 56 : 8;
                const last = idx === bars.length - 1;
                return (
                  <div
                    key={b.date ?? idx}
                    title={(b.date ?? '') + ': ' + fmtUsd(b.close)}
                    style={{
                      flex: 1,
                      height: h + 'px',
                      borderRadius: '2px 2px 0 0',
                      background: last ? trendColor(summary.changePct1d) : 'var(--ds-border-subtle)',
                    }}
                  />
                );
              })}
            </div>
            <Row justify="space-between">
              <Text size="xs" color="muted">{bars[0]?.date}</Text>
              <Text size="xs" color="muted">{bars[bars.length - 1]?.date}</Text>
            </Row>
          </Section>
        )}

        <Divider subtle />

        <Section title={'News (' + String(news.length) + ')'}>
          {news.length === 0 ? (
            <Text color="muted">No sourced coverage in the window.</Text>
          ) : (
            <Column gap="sm">
              {news.map((item, idx) => (
                <Column key={item.url ?? idx} gap="xs">
                  <a href={item.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-text)', fontWeight: 600, textDecoration: 'none' }}>
                    {item.title}
                  </a>
                  <Text size="xs" color="muted">{item.source} · {item.publishedAt}{item.note ? ' — ' + item.note : ''}</Text>
                </Column>
              ))}
            </Column>
          )}
        </Section>

        {watchItems.length > 0 && (
          <Section title="Watch">
            <Column gap="xs">
              {watchItems.map((item, idx) => (
                <Row key={idx} gap="sm" align="center">
                  <Badge variant="warning">!</Badge>
                  <Text size="sm">{item}</Text>
                </Row>
              ))}
            </Column>
          </Section>
        )}

        <Section title="Brief">
          <Text size="sm">{data?.brief}</Text>
        </Section>
      </Column>
    </Card>
  );
}
`.trim();

const DIGEST_CARD_SAMPLE_DATA = {
  ticker: 'AAPL',
  companyName: 'Apple Inc.',
  asOf: '2026-07-17',
  focus: null,
  priceSummary: {
    lastClose: 262.35,
    changePct1d: 1.24,
    high30d: 266.8,
    low30d: 243.1,
    changePct30d: 6.42,
    avgVolume30d: 54200000,
  },
  bars: [
    { date: '2026-06-08', close: 246.53, volume: 51200000 },
    { date: '2026-06-09', close: 247.9, volume: 48900000 },
    { date: '2026-06-10', close: 245.11, volume: 60100000 },
    { date: '2026-06-11', close: 243.87, volume: 65400000 },
    { date: '2026-06-12', close: 244.62, volume: 47800000 },
    { date: '2026-06-15', close: 247.35, volume: 52300000 },
    { date: '2026-06-16', close: 249.04, volume: 49500000 },
    { date: '2026-06-17', close: 250.62, volume: 53100000 },
    { date: '2026-06-18', close: 249.8, volume: 44900000 },
    { date: '2026-06-19', close: 252.17, volume: 71200000 },
    { date: '2026-06-22', close: 253.4, volume: 50600000 },
    { date: '2026-06-23', close: 255.02, volume: 48200000 },
    { date: '2026-06-24', close: 253.75, volume: 46700000 },
    { date: '2026-06-25', close: 256.4, volume: 55800000 },
    { date: '2026-06-26', close: 257.85, volume: 58300000 },
    { date: '2026-06-29', close: 256.9, volume: 43200000 },
    { date: '2026-06-30', close: 258.42, volume: 61500000 },
    { date: '2026-07-01', close: 259.1, volume: 52800000 },
    { date: '2026-07-02', close: 257.6, volume: 49100000 },
    { date: '2026-07-06', close: 260.25, volume: 54600000 },
    { date: '2026-07-07', close: 261.7, volume: 57200000 },
    { date: '2026-07-08', close: 260.4, volume: 45900000 },
    { date: '2026-07-09', close: 262.9, volume: 59800000 },
    { date: '2026-07-10', close: 264.15, volume: 62400000 },
    { date: '2026-07-13', close: 266.8, volume: 68900000 },
    { date: '2026-07-14', close: 264.3, volume: 55700000 },
    { date: '2026-07-15', close: 261.05, volume: 63100000 },
    { date: '2026-07-16', close: 259.14, volume: 58600000 },
    { date: '2026-07-17', close: 262.35, volume: 56400000 },
  ],
  news: [
    {
      title: 'Apple supplier ramp points to earlier-than-usual fall product cycle',
      source: 'Reuters',
      url: 'https://www.reuters.com/technology/apple-supplier-ramp-2026-07-16/',
      publishedAt: '2026-07-16',
      note: 'Coincides with the July 13 window high of 266.80 before the pullback.',
    },
    {
      title: 'Services growth keeps Apple margin guidance intact, analysts say',
      source: 'Bloomberg',
      url: 'https://www.bloomberg.com/news/articles/2026-07-14/apple-services-margin',
      publishedAt: '2026-07-14',
      note: null,
    },
    {
      title: 'Apple expands on-device AI features to older iPhone models',
      source: 'The Verge',
      url: 'https://www.theverge.com/2026/7/10/apple-on-device-ai-older-iphones',
      publishedAt: '2026-07-10',
      note: null,
    },
  ],
  watchItems: [
    'Price is 1.7% below the July 13 window high of 266.80 after a three-session pullback.',
    'July 16 volume (58.6M) ran above the 30-day average of 54.2M on a down session.',
    'Earnings window flagged in supplier-ramp coverage (Reuters, Jul 16) — dates unconfirmed.',
  ],
  brief:
    'AAPL closed at 262.35 on Jul 17, up 1.24% on the day and 6.42% over the ~30-session window (243.10–266.80 range). The advance stalled after the Jul 13 high, with two above-average-volume down sessions before Friday’s rebound. Coverage centers on an earlier fall product cycle and resilient services margins. Watch whether the pullback holds above the 260 area where the last two weeks based.',
};

export const TICKER_DIGEST_CARD_SEED: BundleArtifactSeedInput = {
  bindingId: 'digest-card',
  bundleArtifactKey: 'ticker-digest:digest-card',
  name: 'Ticker Digest Card',
  kind: 'react_tsx' as const,
  source: DIGEST_CARD_TSX,
  dataSchema: TICKER_DIGEST_DATA_SCHEMA,
  sampleData: DIGEST_CARD_SAMPLE_DATA,
  catalogPin: TICKER_DIGEST_CATALOG_PIN,
  tags: ['market-data', 'news'],
  description:
    'Inline market-digest card: price summary, daily-close trend strip, sourced news links, watch items, and the prose brief for one ticker.',
};
