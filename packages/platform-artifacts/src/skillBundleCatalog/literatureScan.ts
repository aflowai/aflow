import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';
import { ARXIV_CONNECTOR } from '../connectorCatalog/arxiv.js';
import { SEMANTIC_SCHOLAR_CONNECTOR } from '../connectorCatalog/semanticscholar.js';
import { PUBMED_CONNECTOR } from '../connectorCatalog/pubmed.js';
import { bundledApiDefinitionFromConnector } from './connectorApiDefinitions.js';
import { LITERATURE_SCAN_CARD_SEED } from './literatureScanArtifactSeed.js';

const SEMANTIC_SCHOLAR_KEY_CREDENTIAL = 'semantic-scholar-api-key';

export const LITERATURE_SCAN: SkillBundleInput = {
  bundleId: 'literature-scan' as SkillBundleId,
  version: 6,
  name: 'Literature Scan',
  tagline:
    'Survey the academic literature on a topic: search arXiv, Semantic Scholar and PubMed, sourced scan, inline card. One free key.',
  description: `Wires up the **arXiv**, **Semantic Scholar**, and **PubMed** integrations and the **Literature Scan** skill — ask about a research topic and get an inline card: a synthesis of what the literature says, the key papers each linking its source, the themes the work clusters into, open gaps, and a coverage note. Every paper traces to a real source URL.

**What you get**:
- The **arXiv** API definition (preprint search) + a default keyless binding.
- The **Semantic Scholar** definition (paper search, paper/citation lookup) + a default binding ready for your free Semantic Scholar API key.
- The **PubMed** definition (NCBI E-utilities search → summaries) + a default keyless binding.
- The **Literature Scan** skill — papers gathered across the relevant sources with honest gap-reporting (search → select the key papers → gather metadata), the scan composed against a typed contract where every paper's source URL is required, and the bundled card rendered inline.
- The **scan card** artifact the skill renders — seeded with the exact data schema the compose step is held to.

**After install**:
1. Go to **Integrations → API integrations** and paste your **Semantic Scholar API key** (free at semanticscholar.org/product/api — the key lifts the anonymous tier's low rate limit so more calls land). arXiv and PubMed need nothing — they are keyless.
2. Ask about a research topic — "literature scan on diffusion models for protein structure prediction", optionally with a focus note ("recent work"). One run surveys one topic.`,
  tags: ['research', 'academic', 'papers', 'citations', 'literature'],
  skillCatalogIds: ['literature-review'],
  prerequisiteBundleIds: [],
  apiDefinitions: [
    bundledApiDefinitionFromConnector(ARXIV_CONNECTOR),
    bundledApiDefinitionFromConnector(SEMANTIC_SCHOLAR_CONNECTOR),
    bundledApiDefinitionFromConnector(PUBMED_CONNECTOR),
  ],
  apiBindingTemplates: [
    {
      bindingId: 'arxiv-default',
      apiId: 'arxiv',
      name: 'Default',
      description:
        'Keyless read-only arXiv preprint search. No credential required — arXiv is a public API.',
      authShape: { type: 'none' as const },
      credentialSlots: [],
      egressPolicy: {
        allowedHosts: ['export.arxiv.org'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'semantic-scholar-default',
      apiId: 'semantic-scholar',
      name: 'Default',
      description:
        'Read-only Semantic Scholar Academic Graph: paper search, paper/citation lookup. Paste your free Semantic Scholar API key as the credential; it is sent as the x-api-key header and lifts the anonymous tier’s low rate limit.',
      authShape: {
        type: 'api_key' as const,
        placement: 'header' as const,
        headerName: 'x-api-key',
      },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: SEMANTIC_SCHOLAR_KEY_CREDENTIAL,
          role: 'api_key' as const,
          label: 'Semantic Scholar API key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['api.semanticscholar.org'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'pubmed-default',
      apiId: 'pubmed',
      name: 'Default',
      description:
        'Keyless read-only PubMed / NCBI E-utilities: search → summaries. No credential required — the E-utilities read API is public.',
      authShape: { type: 'none' as const },
      credentialSlots: [],
      egressPolicy: {
        allowedHosts: ['eutils.ncbi.nlm.nih.gov'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  memorySeed: [],
  artifactSeed: [LITERATURE_SCAN_CARD_SEED],
  helmsmanHints: [
    'After install, go to Integrations → API integrations and paste the free Semantic Scholar API key (x-api-key header) — one credential. arXiv and PubMed are keyless public APIs and need nothing.',
    'One run surveys ONE topic: start the literature-scan workflow with input { topic } plus an optional { focus } note. For several topics, start one run per topic.',
    'The scan card mounted by the run IS the deliverable — relay its headline answer and any coverage gaps the run reports; do not re-narrate every paper in prose.',
  ],
};
