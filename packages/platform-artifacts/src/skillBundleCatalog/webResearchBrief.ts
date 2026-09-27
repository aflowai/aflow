import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';
import { BRAVE_CONNECTOR } from '../connectorCatalog/brave.js';
import { FIRECRAWL_CONNECTOR } from '../connectorCatalog/firecrawl.js';
import { bundledApiDefinitionFromConnector } from './connectorApiDefinitions.js';
import { WEB_RESEARCH_BRIEF_CARD_SEED } from './webResearchBriefArtifactSeed.js';

const BRAVE_TOKEN_CREDENTIAL = 'brave-subscription-token';
const FIRECRAWL_KEY_CREDENTIAL = 'firecrawl-api-key';

export const WEB_RESEARCH_BRIEF: SkillBundleInput = {
  bundleId: 'web-research' as SkillBundleId,
  version: 2,
  name: 'Web Research Brief',
  tagline:
    'Research any question on the open web: search, read sources, sourced brief, inline card.',
  description: `Wires up the **Brave Search** and **Firecrawl** integrations and the **Web Research Brief** skill — ask a research question and get an inline card: a direct answer, findings each linking the page they came from, open questions the sources left unresolved, and a bibliography. Every finding traces to a page that was actually fetched.

**What you get**:
- The **Brave Search** API definition (web + news search) + a default binding ready for your Brave subscription token.
- The **Firecrawl** definition (scrape a URL into clean markdown, and the crawl/map/search endpoints) + a default Bearer binding ready for your Firecrawl key.
- The **Web Research Brief** skill — evidence gathered with honest gap-reporting (search → select the best hits → fetch the chosen pages), the brief composed against a typed contract where every finding's source URL is required, and the bundled card rendered inline.
- The **brief card** artifact the skill renders — seeded with the exact data schema the compose step is held to.

**After install**:
1. Go to **Integrations → API integrations** and paste your **Brave Search subscription token** (api-dashboard.search.brave.com; the free plan is enough) and your **Firecrawl API key** (firecrawl.dev, starts with "fc-").
2. Ask a research question — "brief on the state of solid-state batteries in 2026", optionally with a focus note ("focus on cost per kWh"). One run briefs one question.`,
  tags: ['research', 'web-search', 'scraping', 'brief', 'sources'],
  skillCatalogIds: ['web-research-brief'],
  prerequisiteBundleIds: [],
  apiDefinitions: [
    bundledApiDefinitionFromConnector(BRAVE_CONNECTOR),
    bundledApiDefinitionFromConnector(FIRECRAWL_CONNECTOR),
  ],
  apiBindingTemplates: [
    {
      bindingId: 'brave-default',
      apiId: 'brave-search',
      name: 'Default',
      description:
        'Read-only Brave Search: web and news search. Paste your Brave subscription token as the credential; it is sent as the X-Subscription-Token header.',
      authShape: {
        type: 'api_key' as const,
        placement: 'header' as const,
        headerName: 'X-Subscription-Token',
      },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: BRAVE_TOKEN_CREDENTIAL,
          role: 'api_key' as const,
          label: 'Brave subscription token',
        },
      ],
      egressPolicy: {
        allowedHosts: ['api.search.brave.com'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'firecrawl-default',
      apiId: 'firecrawl',
      name: 'Default',
      description:
        'Firecrawl scrape/crawl/map/search. Paste your Firecrawl API key as the credential; it is sent as Authorization: Bearer.',
      authShape: { type: 'bearer' as const },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: FIRECRAWL_KEY_CREDENTIAL,
          role: 'token' as const,
          label: 'Firecrawl API key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['api.firecrawl.dev'],
        allowedMethods: ['GET' as const, 'POST' as const],
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  memorySeed: [],
  artifactSeed: [WEB_RESEARCH_BRIEF_CARD_SEED],
  helmsmanHints: [
    'After install, go to Integrations → API integrations and paste the Brave Search subscription token (X-Subscription-Token header) and the Firecrawl API key (Bearer) — one credential each.',
    'One run briefs ONE question: start the web-research-brief workflow with input { question } plus an optional { focus } note. For several questions, start one run per question.',
    'The brief card mounted by the run IS the deliverable — relay its answer and any coverage gaps the run reports; do not re-narrate every finding in prose.',
  ],
};
