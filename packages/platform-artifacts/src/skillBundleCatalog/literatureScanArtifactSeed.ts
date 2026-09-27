import type { SkillBundleInput } from '@aflow/schemas';
import { LITERATURE_SCAN_DATA_SCHEMA } from '../skillCatalog/literatureScanShape.js';

type BundleArtifactSeedInput = NonNullable<SkillBundleInput['artifactSeed']>[number];

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion (guard-tested against the compact contract);
// 'fallback' marks the hash slot as intentionally unpinned.
const SCAN_CARD_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

const SOURCE_LABELS = {
  arxiv: 'arXiv',
  semantic_scholar: 'Semantic Scholar',
  pubmed: 'PubMed',
};

const SCAN_CARD_TSX = `
import React from 'react';
import { Card, Column, Row, Section, Heading, Text, Badge, Panel, Divider } from '@aflow/design-system';

const SOURCE_LABELS = ${JSON.stringify(SOURCE_LABELS)};

export default function LiteratureScanCard({ data }) {
  const papers = Array.isArray(data?.papers) ? data.papers : [];
  const themes = Array.isArray(data?.themes) ? data.themes : [];
  const gaps = Array.isArray(data?.gaps) ? data.gaps : [];

  const hostOf = (url) => {
    if (typeof url !== 'string') return '';
    try {
      return new URL(url).hostname.replace(/^www\\./, '');
    } catch {
      return url;
    }
  };
  const authorsOf = (authors) => {
    if (!Array.isArray(authors) || authors.length === 0) return '';
    if (authors.length <= 3) return authors.join(', ');
    return authors.slice(0, 3).join(', ') + ' et al.';
  };
  const sourceLabel = (source) => SOURCE_LABELS[source] || source;

  return (
    <Card elevated padding="lg">
      <Column gap="md">
        <Column gap="xs">
          <Heading level={3}>{data?.topic}</Heading>
          <Row gap="sm" align="center" wrap>
            <Badge variant="info">{String(papers.length)} papers</Badge>
            <Badge variant="neutral">{String(themes.length)} themes</Badge>
          </Row>
        </Column>

        <Section title="Synthesis">
          <Text size="sm">{data?.summary}</Text>
        </Section>

        <Divider subtle />

        <Section title={'Papers (' + String(papers.length) + ')'}>
          {papers.length === 0 ? (
            <Text color="muted">No sourced papers.</Text>
          ) : (
            <Column gap="md">
              {papers.map((p, idx) => (
                <Panel key={idx} padding="md" variant="elevated">
                  <Column gap="xs">
                    <Text size="sm" variant="label">{p.title}</Text>
                    <Row gap="sm" align="center" wrap>
                      <Text size="xs" color="muted">{authorsOf(p.authors)}</Text>
                      {p.year != null && <Badge variant="neutral">{String(p.year)}</Badge>}
                      {p.venue && <Text size="xs" color="muted">{p.venue}</Text>}
                      {p.citationCount != null && (
                        <Badge variant="info">{String(p.citationCount)} citations</Badge>
                      )}
                    </Row>
                    <Text size="sm" color="muted">{p.keyPoint}</Text>
                    <a href={p.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-accent)', textDecoration: 'none', fontSize: '0.8125rem' }}>
                      {sourceLabel(p.source)} — {hostOf(p.url)} ↗
                    </a>
                  </Column>
                </Panel>
              ))}
            </Column>
          )}
        </Section>

        {themes.length > 0 && (
          <Section title="Themes">
            <Column gap="sm">
              {themes.map((t, idx) => (
                <Column key={idx} gap="xs">
                  <Text size="sm" variant="label">{t.name}</Text>
                  <Text size="xs" color="muted">{t.description}</Text>
                </Column>
              ))}
            </Column>
          </Section>
        )}

        {gaps.length > 0 && (
          <Section title="Open gaps">
            <Column gap="xs">
              {gaps.map((g, idx) => (
                <Row key={idx} gap="sm" align="center">
                  <Badge variant="warning">?</Badge>
                  <Text size="sm">{g}</Text>
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
      </Column>
    </Card>
  );
}
`.trim();

const SCAN_CARD_SAMPLE_DATA = {
  topic: 'Diffusion models for protein structure prediction',
  summary:
    'Diffusion-based generative models have become a dominant approach to protein structure prediction and design since 2022, moving the field beyond the regression-style prediction that AlphaFold2 established. The strongest recent systems frame backbone generation as a denoising diffusion process over residue frames, which produces diverse, designable structures and supports conditional generation (binders, symmetric assemblies, functional motifs). Evaluations report high in-silico designability and growing experimental validation, though wet-lab success rates and the handling of ligands and multi-chain complexes remain actively contested. The literature clusters into de-novo backbone generation, sequence-conditioned structure prediction, and the co-design of sequence and structure, with the main open gaps in experimental throughput and in modeling non-protein context.',
  papers: [
    {
      title: 'De novo design of protein structure and function with RFdiffusion',
      authors: ['Joseph L. Watson', 'David Juergens', 'Nathaniel R. Bennett', 'David Baker'],
      year: 2023,
      venue: 'Nature',
      url: 'https://www.semanticscholar.org/paper/2f3f1b6c8a9d4e2b1c7a0e5d3f8b9c6a7e4d2f10',
      citationCount: 1240,
      source: 'semantic_scholar',
      keyPoint:
        'Introduces RFdiffusion, a denoising diffusion model fine-tuned from RoseTTAFold that generates designable protein backbones and enables binder and motif-scaffold design, with experimental validation of several designs.',
    },
    {
      title: 'Illuminating protein space with a programmable generative model (Chroma)',
      authors: ['John B. Ingraham', 'Max Baranov', 'Zak Costello', 'Gevorg Grigoryan'],
      year: 2023,
      venue: 'Nature',
      url: 'https://arxiv.org/abs/2211.05248',
      citationCount: 610,
      source: 'arxiv',
      keyPoint:
        'Presents Chroma, a diffusion model over protein structure with a scalable graph-based architecture and programmable conditioning on symmetry, shape, and semantic constraints.',
    },
    {
      title: 'Robust deep learning-based protein sequence design using ProteinMPNN',
      authors: ['Justas Dauparas', 'Ivan Anishchenko', 'Nathaniel Bennett', 'David Baker'],
      year: 2022,
      venue: 'Science',
      url: 'https://pubmed.ncbi.nlm.nih.gov/36108050/',
      citationCount: 1980,
      source: 'pubmed',
      keyPoint:
        'ProteinMPNN recovers native-like sequences for a given backbone at high accuracy and is the standard sequence-design step paired with diffusion-generated backbones.',
    },
    {
      title:
        'Diffusion probabilistic modeling of protein backbones in 3D for the motif-scaffolding problem',
      authors: ['Brian L. Trippe', 'Jason Yim', 'Doug Tischer', 'Tommi Jaakkola'],
      year: 2022,
      venue: 'arXiv preprint',
      url: 'https://arxiv.org/abs/2206.04119',
      source: 'arxiv',
      keyPoint:
        'Formulates protein backbone generation as SE(3)-equivariant diffusion and casts motif scaffolding as conditional sampling, an early framework the later backbone-diffusion systems build on.',
    },
    {
      title: 'Fast and accurate protein structure prediction from sequence with AlphaFold2',
      authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel', 'Demis Hassabis'],
      year: 2021,
      venue: 'Nature',
      url: 'https://pubmed.ncbi.nlm.nih.gov/34265844/',
      citationCount: 24500,
      source: 'pubmed',
      keyPoint:
        'The regression-based prediction baseline the diffusion literature situates itself against — high-accuracy single-structure prediction, but without the diverse, controllable generation diffusion adds.',
    },
  ],
  themes: [
    {
      name: 'De-novo backbone generation',
      description:
        'Diffusion over residue frames to generate new, designable backbones — RFdiffusion, Chroma, and the SE(3)-diffusion line.',
    },
    {
      name: 'Sequence design for generated structures',
      description:
        'Inverse-folding models such as ProteinMPNN that assign a foldable sequence to a diffusion-generated backbone; the standard second stage of the pipeline.',
    },
    {
      name: 'Conditional and functional design',
      description:
        'Conditioning generation on motifs, symmetry, binders, and functional sites — the shift from prediction to programmable design.',
    },
  ],
  gaps: [
    'Experimental (wet-lab) success rates are reported unevenly and are hard to compare across papers.',
    'Modeling non-protein context — ligands, ions, and nucleic acids — during diffusion is still limited.',
    'Multi-chain and large-assembly generation lags single-chain performance.',
  ],
  coverageNote:
    'Searched Semantic Scholar (cross-domain, citation counts), arXiv (preprints), and PubMed (biomedical). Five papers gathered spanning the three sources: the backbone-diffusion systems, the standard sequence-design model, an early formative preprint, and the AlphaFold2 prediction baseline. Citation counts come from Semantic Scholar and PubMed-linked records where the source reported them. The Trippe et al. preprint had no citation count in the gathered record, so none is shown. Coverage of de-novo design and sequence design is strong; ligand-aware and full-complex diffusion is thinner in the gathered set and is flagged as an open gap.',
};

export const LITERATURE_SCAN_CARD_SEED: BundleArtifactSeedInput = {
  bindingId: 'scan-card',
  bundleArtifactKey: 'literature-scan:scan-card',
  name: 'Literature Scan Card',
  kind: 'react_tsx' as const,
  source: SCAN_CARD_TSX,
  dataSchema: LITERATURE_SCAN_DATA_SCHEMA,
  sampleData: SCAN_CARD_SAMPLE_DATA,
  catalogPin: SCAN_CARD_CATALOG_PIN,
  tags: ['research', 'academic', 'papers'],
  description:
    'Inline literature-scan card: the synthesis, the key papers each linking its source, the themes they cluster into, open gaps, and a coverage note.',
};
