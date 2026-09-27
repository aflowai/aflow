import type { SkillBundleInput } from '@aflow/schemas';
import { WEB_RESEARCH_BRIEF_DATA_SCHEMA } from '../skillCatalog/webResearchBriefShape.js';

type BundleArtifactSeedInput = NonNullable<SkillBundleInput['artifactSeed']>[number];

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion (guard-tested against the compact contract);
// 'fallback' marks the hash slot as intentionally unpinned.
const BRIEF_CARD_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

const BRIEF_CARD_TSX = `
import React from 'react';
import { Card, Column, Row, Section, Heading, Text, Badge, Panel, Divider } from '@aflow/design-system';

export default function WebResearchBriefCard({ data }) {
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const openQuestions = Array.isArray(data?.openQuestions) ? data.openQuestions : [];
  const sources = Array.isArray(data?.sources) ? data.sources : [];

  const hostOf = (url) => {
    if (typeof url !== 'string') return '';
    try {
      return new URL(url).hostname.replace(/^www\\./, '');
    } catch {
      return url;
    }
  };

  return (
    <Card elevated padding="lg">
      <Column gap="md">
        <Column gap="xs">
          <Heading level={3}>{data?.title}</Heading>
          <Row gap="sm" align="center" wrap>
            <Badge variant="info">{String(sources.length)} sources</Badge>
            <Badge variant="neutral">{String(findings.length)} findings</Badge>
          </Row>
        </Column>

        <Section title="Answer">
          <Text size="sm">{data?.summary}</Text>
        </Section>

        <Divider subtle />

        <Section title={'Findings (' + String(findings.length) + ')'}>
          {findings.length === 0 ? (
            <Text color="muted">No sourced findings.</Text>
          ) : (
            <Column gap="md">
              {findings.map((f, idx) => (
                <Panel key={idx} padding="md" variant="elevated">
                  <Column gap="xs">
                    <Text size="sm" variant="label">{f.claim}</Text>
                    <Text size="sm" color="muted">{f.detail}</Text>
                    <a href={f.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-accent)', textDecoration: 'none', fontSize: '0.8125rem' }}>
                      {f.sourceTitle || hostOf(f.sourceUrl)} ↗
                    </a>
                  </Column>
                </Panel>
              ))}
            </Column>
          )}
        </Section>

        {openQuestions.length > 0 && (
          <Section title="Open questions">
            <Column gap="xs">
              {openQuestions.map((q, idx) => (
                <Row key={idx} gap="sm" align="center">
                  <Badge variant="warning">?</Badge>
                  <Text size="sm">{q}</Text>
                </Row>
              ))}
            </Column>
          </Section>
        )}

        {data?.coverageNote && (
          <Section title="Coverage">
            <Text size="xs" color="muted">{data.coverageNote}</Text>
          </Section>
        )}

        <Divider subtle />

        <Section title={'Sources (' + String(sources.length) + ')'}>
          <Column gap="xs">
            {sources.map((s, idx) => (
              <a key={idx} href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-text)', textDecoration: 'none' }}>
                <Text size="xs">{s.title} — <span style={{ color: 'var(--ds-text-muted)' }}>{hostOf(s.url)}</span></Text>
              </a>
            ))}
          </Column>
        </Section>
      </Column>
    </Card>
  );
}
`.trim();

const BRIEF_CARD_SAMPLE_DATA = {
  title: 'State of solid-state EV batteries in 2026',
  summary:
    'Solid-state batteries moved from lab to limited pilot production in 2026 but remain years from mass-market EVs. Toyota and QuantumScape both reported validated cells with higher energy density and faster charging than current lithium-ion, yet cost per kWh is still several times that of established chemistries, and durable large-format manufacturing is the unresolved bottleneck. Most credible roadmaps now point to meaningful passenger-EV volume in the 2027–2028 window rather than 2026.',
  findings: [
    {
      claim: 'Toyota is targeting solid-state EV production in the 2027–2028 window, not 2026.',
      detail:
        'Toyota reaffirmed a roadmap that pairs solid-state cells with a specific EV platform, citing roughly 1,000 km range and ~10-minute fast charge as targets, with initial low-volume output rather than mass production at launch.',
      sourceUrl:
        'https://www.reuters.com/business/autos-transportation/toyota-solid-state-2026-07-14/',
      sourceTitle: 'Toyota details solid-state battery timeline',
    },
    {
      claim:
        'QuantumScape reported validated multi-layer cells but has not reached commercial-scale output.',
      detail:
        'The company shipped higher-layer-count prototype cells to automakers for testing and highlighted cycle-life results, while acknowledging that ramping its separator manufacturing to volume remains the gating step.',
      sourceUrl: 'https://www.bloomberg.com/news/articles/2026-07-10/quantumscape-cell-validation',
      sourceTitle: 'QuantumScape ships validation cells to automakers',
    },
    {
      claim: 'Cost per kWh for solid-state cells is still well above conventional lithium-ion.',
      detail:
        'An industry analysis put early solid-state pack costs at a multiple of today’s NMC and LFP packs, attributing the gap to low yields and expensive lithium-metal anode handling rather than materials cost alone.',
      sourceUrl: 'https://about.bnef.com/insights/clean-transport/solid-state-cost-2026/',
      sourceTitle: 'BloombergNEF: solid-state cost outlook 2026',
    },
    {
      claim: 'Manufacturing durable large-format cells is the consensus bottleneck, not chemistry.',
      detail:
        'A review of pilot lines found that dendrite suppression and defect-free large-area solid electrolyte layers, not cell chemistry, are what separate lab results from automotive-grade yield.',
      sourceUrl: 'https://www.nature.com/articles/s41560-026-solid-state-review',
      sourceTitle: 'Nature Energy: scaling solid-state manufacturing',
    },
  ],
  openQuestions: [
    'No independent, audited cost-per-kWh figures for at-scale production were available — the cost claims rest on modeled estimates.',
    'Cycle-life data comes largely from manufacturer disclosures, not third-party testing.',
  ],
  sources: [
    {
      url: 'https://www.reuters.com/business/autos-transportation/toyota-solid-state-2026-07-14/',
      title: 'Toyota details solid-state battery timeline',
    },
    {
      url: 'https://www.bloomberg.com/news/articles/2026-07-10/quantumscape-cell-validation',
      title: 'QuantumScape ships validation cells to automakers',
    },
    {
      url: 'https://about.bnef.com/insights/clean-transport/solid-state-cost-2026/',
      title: 'BloombergNEF: solid-state cost outlook 2026',
    },
    {
      url: 'https://www.nature.com/articles/s41560-026-solid-state-review',
      title: 'Nature Energy: scaling solid-state manufacturing',
    },
  ],
  coverageNote:
    'Four authoritative sources fetched (two major newswires, one industry research house, one peer-reviewed review). Timeline and validation claims are well-covered; cost figures rely on a single modeled analysis, and no source gave audited at-scale production costs. The Nature review is behind a partial paywall — the abstract and methods were read, the full appendices were not.',
};

export const WEB_RESEARCH_BRIEF_CARD_SEED: BundleArtifactSeedInput = {
  bindingId: 'brief-card',
  bundleArtifactKey: 'web-research:brief-card',
  name: 'Web Research Brief Card',
  kind: 'react_tsx' as const,
  source: BRIEF_CARD_TSX,
  dataSchema: WEB_RESEARCH_BRIEF_DATA_SCHEMA,
  sampleData: BRIEF_CARD_SAMPLE_DATA,
  catalogPin: BRIEF_CARD_CATALOG_PIN,
  tags: ['research', 'web-search'],
  description:
    'Inline research-brief card: the answer, sourced findings each linking their page, open questions, a coverage note, and the source bibliography.',
};
