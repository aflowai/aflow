'use client';

import { useState, useEffect, useMemo } from 'react';
import { AppPageHeader } from '../components/app-page-header.js';
import {
  Card,
  CardBody,
  Text,
  Heading,
  Badge,
  Row,
  Column,
  Grid,
  Divider,
  Icon,
  Avatar,
  PageContainer,
  EmptyState,
  Tooltip,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  SearchField,
  FilterChips,
  Toolbar,
  ToolbarRow,
  Section,
  Spacer,
  useBreakpoint,
  type FilterChipOption,
} from '@aflow/design-system';
import { useApi } from '../components/providers.js';
import {
  OperationTree,
  type StepType,
  type Operation,
} from '../components/catalog/OperationTree.js';

// ---------------------------------------------------------------------------
// Types — Models (operations types imported from OperationTree)
// ---------------------------------------------------------------------------

interface ModelCapabilities {
  chat: boolean;
  completion: boolean;
  embedding: boolean;
  vision: boolean;
  audio: boolean;
  functionCalling: boolean;
  jsonMode: boolean;
  streaming: boolean;
  reasoning?: boolean;
  structuredOutputs?: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
}

interface ModelTraits {
  speed?: number;
  cost?: number;
  intelligence?: number;
  outputType?: 'text' | 'image' | 'video' | 'audio' | 'embedding';
}

interface Model {
  modelId: string;
  provider: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  pricing: {
    promptPer1M: number;
    completionPer1M: number;
    imagePerImage?: number;
    videoPerSecond?: number;
    currency: string;
  };
  traits?: ModelTraits;
  deprecated?: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Reusable catalog content — used both standalone and in space settings tab. */
export function CatalogContent() {
  const { apiUrl, headers } = useApi();
  const [stepTypes, setStepTypes] = useState<StepType[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchCatalog() {
      setIsLoading(true);
      setError(null);
      try {
        const [stepsRes, opsRes, modelsRes] = await Promise.all([
          fetch(`${apiUrl}/catalog/step-types`, { headers: headers() }),
          fetch(`${apiUrl}/catalog/operations`, { headers: headers() }),
          fetch(`${apiUrl}/catalog/models`, { headers: headers() }),
        ]);
        if (stepsRes.ok) {
          const d = (await stepsRes.json()) as { stepTypes?: StepType[] };
          setStepTypes(d.stepTypes ?? []);
        }
        if (opsRes.ok) {
          const d = (await opsRes.json()) as { operations?: Operation[] };
          setOperations(d.operations ?? []);
        }
        if (modelsRes.ok) {
          const d = (await modelsRes.json()) as { models?: Model[] };
          setModels(d.models ?? []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch catalog');
      } finally {
        setIsLoading(false);
      }
    }
    void fetchCatalog();
  }, [apiUrl, headers]);

  return (
    <PageContainer>
      <Tabs defaultTab="operations">
        <TabList>
          <Tab id="operations">
            <Row gap="xs" align="center">
              <Icon name="cube" size="sm" />
              <span>Operations</span>
            </Row>
          </Tab>
          <Tab id="models">
            <Row gap="xs" align="center">
              <Icon name="brain" size="sm" />
              <span>AI Models</span>
            </Row>
          </Tab>
        </TabList>

        {isLoading ? null : error ? (
          <EmptyState title="Something went wrong" description={error} />
        ) : (
          <>
            <TabPanel id="operations">
              <OperationTree stepTypes={stepTypes} operations={operations} />
            </TabPanel>
            <TabPanel id="models">
              <Column gap="xl">
                <ModelsGrid models={models} />
              </Column>
            </TabPanel>
          </>
        )}
      </Tabs>
    </PageContainer>
  );
}

export function CatalogPage() {
  return (
    <>
      <AppPageHeader title="Catalog" />
      <CatalogContent />
    </>
  );
}

// Model output type icon helper
// ---------------------------------------------------------------------------
function OutputTypeIcon({ outputType }: { outputType?: string }) {
  const accentColor = 'var(--color-accent-default)';
  if (outputType === 'image')
    return <Icon name="image" size="sm" weight="duotone" color={accentColor} />;
  if (outputType === 'video')
    return <Icon name="video" size="sm" weight="duotone" color={accentColor} />;
  if (outputType === 'embedding')
    return <Icon name="database" size="sm" weight="duotone" color={accentColor} />;
  if (outputType === 'audio')
    return <Icon name="waveform" size="sm" weight="duotone" color={accentColor} />;
  return <Icon name="text" size="sm" weight="regular" color="var(--color-content-muted)" />;
}

// ---------------------------------------------------------------------------
// Trait scale component — renders N filled icons out of 5
// ---------------------------------------------------------------------------
const MAX_SCALE = 5;

function TraitScale({
  iconName,
  value,
  colorHigh,
  colorLow,
  label,
}: {
  iconName: 'lightning' | 'currency-dollar' | 'brain';
  value: number;
  colorHigh: string;
  colorLow: string;
  label: string;
}) {
  const color =
    value >= MAX_SCALE ? colorHigh : value <= 1 ? colorLow : 'var(--color-content-secondary)';

  return (
    <Tooltip content={`${label}: ${value}/${MAX_SCALE}`}>
      <Row gap="xs">
        {Array.from({ length: MAX_SCALE }, (_, i) => (
          <Icon
            key={i}
            name={iconName}
            size={11}
            weight={i < value ? 'fill' : 'light'}
            color={i < value ? color : 'var(--color-border-default)'}
          />
        ))}
      </Row>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Models sort helpers
// ---------------------------------------------------------------------------
type ModelSortField = 'name' | 'cost' | 'context';

function getModelSortValue(m: Model, field: ModelSortField): number | string {
  switch (field) {
    case 'name':
      return m.displayName.toLowerCase();
    case 'cost':
      return m.pricing.imagePerImage ?? m.pricing.videoPerSecond ?? m.pricing.promptPer1M;
    case 'context':
      return m.contextWindow;
  }
}

// ---------------------------------------------------------------------------
// Models filter types
// ---------------------------------------------------------------------------
type OutputTypeFilter = 'all' | 'text' | 'image' | 'video' | 'audio' | 'embedding';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
function ModelsGrid({ models }: { models: Model[] }) {
  const [search, setSearch] = useState('');
  const [outputFilter, setOutputFilter] = useState<OutputTypeFilter>('all');
  const [sortField, setSortField] = useState<ModelSortField>('name');
  const filtered = useMemo(() => {
    let result = models.filter((m) => !m.deprecated);

    if (outputFilter !== 'all') {
      result = result.filter((m) => m.traits?.outputType === outputFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (m) =>
          m.displayName.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          (m.description?.toLowerCase().includes(q) ?? false),
      );
    }

    result.sort((a, b) => {
      const av = getModelSortValue(a, sortField);
      const bv = getModelSortValue(b, sortField);
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv);
      return (av as number) - (bv as number);
    });

    return result;
  }, [models, search, outputFilter, sortField]);

  if (models.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="brain" size="xl" weight="thin" />}
        title="No models available"
        description="Start the backend server to see available AI models"
      />
    );
  }

  const byProvider: Record<string, Model[]> = {};
  for (const m of filtered) {
    (byProvider[m.provider] ??= []).push(m);
  }

  const providerLabel = (p: string) =>
    p === 'openai'
      ? 'OpenAI'
      : p === 'anthropic'
        ? 'Anthropic'
        : p === 'google'
          ? 'Google'
          : p === 'openrouter'
            ? 'OpenRouter'
            : p === 'xai'
              ? 'xAI'
              : p === 'together'
                ? 'Together'
                : p;

  const providerLogos: Record<string, string> = {
    anthropic: 'https://res.cloudinary.com/dr81sh2e0/image/upload/v1761898976/anthropic_ga1bek.png',
    openrouter:
      'https://res.cloudinary.com/dr81sh2e0/image/upload/v1761898976/openrouter_pvnwye.png',
    google: 'https://res.cloudinary.com/dr81sh2e0/image/upload/v1761898976/google_oxfjdn.png',
    openai: 'https://res.cloudinary.com/dr81sh2e0/image/upload/v1761483846/openai_t86qrk.webp',
    together: 'https://res.cloudinary.com/dr81sh2e0/image/upload/v1761915129/together_fmplc9.png',
  };

  const outputTypeOptions: FilterChipOption[] = [
    { value: 'all', label: 'All' },
    { value: 'text', label: 'Text' },
    { value: 'image', label: 'Image' },
    { value: 'video', label: 'Video' },
    { value: 'audio', label: 'Audio' },
    { value: 'embedding', label: 'Embedding' },
  ];

  const sortOptions: FilterChipOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'cost', label: 'Cost' },
    { value: 'context', label: 'Context' },
  ];

  const { isMobile } = useBreakpoint();

  return (
    <Column gap="xl">
      <Toolbar>
        <SearchField
          placeholder="Search models..."
          value={search}
          onValueChange={setSearch}
          style={{ maxWidth: isMobile ? undefined : 360 }}
        />

        <ToolbarRow gap="xl" wrap>
          <Section title="Output" gap="sm">
            <FilterChips
              options={outputTypeOptions}
              value={outputFilter}
              onChange={(v) => {
                setOutputFilter(v as OutputTypeFilter);
              }}
            />
          </Section>

          {!isMobile && <Divider />}

          <Section title="Sort" gap="sm">
            <FilterChips
              options={sortOptions}
              value={sortField}
              onChange={(v) => {
                setSortField(v as ModelSortField);
              }}
            />
          </Section>
        </ToolbarRow>
      </Toolbar>

      <Divider subtle />

      {filtered.length === 0 ? (
        <EmptyState title="No matching models" description="Try adjusting your search or filters" />
      ) : (
        <Column gap="2xl">
          {Object.entries(byProvider).map(([provider, providerModels]) => (
            <Column key={provider}>
              <Row>
                {(() => {
                  const logoUrl = providerLogos[provider.toLowerCase()];
                  return logoUrl ? (
                    <Avatar src={logoUrl} alt={providerLabel(provider)} size="md" />
                  ) : null;
                })()}
                <Heading level={5}>{providerLabel(provider)}</Heading>
              </Row>
              <Grid>
                {providerModels.map((model) => (
                  <ModelCard key={model.modelId} model={model} />
                ))}
              </Grid>
            </Column>
          ))}
        </Column>
      )}

      <Text variant="muted" size="xs" align="right">
        {filtered.length} of {models.length} models
      </Text>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Model Card
// ---------------------------------------------------------------------------
function ModelCard({ model }: { model: Model }) {
  const outputType = model.traits?.outputType;
  const isMedia =
    outputType === 'image' ||
    outputType === 'video' ||
    outputType === 'audio' ||
    outputType === 'embedding';

  return (
    <Card interactive style={model.deprecated ? { opacity: 0.6 } : undefined}>
      <CardBody>
        <Column gap="lg" grow>
          <Row gap="md" align="start" justify="between">
            <Column gap="sm">
              <Row gap="md">
                {outputType !== undefined ? <OutputTypeIcon outputType={outputType} /> : null}
                <Heading level={6}>{model.displayName}</Heading>
              </Row>
              <Text variant="mono" size="xs" color="muted">
                {model.modelId}
              </Text>
            </Column>
            {isMedia && (
              <Badge variant="accent" icon={<OutputTypeIcon outputType={outputType} />}>
                {outputType === 'image'
                  ? 'Image'
                  : outputType === 'video'
                    ? 'Video'
                    : outputType === 'audio'
                      ? 'Audio'
                      : 'Embedding'}
              </Badge>
            )}
          </Row>

          {model.description && (
            <Text variant="muted" size="sm">
              {model.description}
            </Text>
          )}

          <Spacer />
          <Divider subtle />

          {model.traits && (
            <Row gap="lg" wrap>
              {model.traits.speed != null && (
                <TraitScale
                  iconName="lightning"
                  value={model.traits.speed}
                  colorHigh="var(--color-status-succeeded-fg)"
                  colorLow="var(--color-status-paused-fg)"
                  label="Speed"
                />
              )}
              {model.traits.cost != null && (
                <TraitScale
                  iconName="currency-dollar"
                  value={model.traits.cost}
                  colorHigh="var(--color-status-failed-fg)"
                  colorLow="var(--color-status-succeeded-fg)"
                  label="Cost"
                />
              )}
              {model.traits.intelligence != null && (
                <TraitScale
                  iconName="brain"
                  value={model.traits.intelligence}
                  colorHigh="var(--color-accent-default)"
                  colorLow="var(--color-content-muted)"
                  label="Intelligence"
                />
              )}
            </Row>
          )}

          <Row gap="sm" wrap>
            {model.contextWindow > 0 && (
              <Badge variant="neutral">{formatContextWindow(model.contextWindow)}</Badge>
            )}
            {model.capabilities.streaming && <Badge variant="neutral">Streaming</Badge>}
            {model.capabilities.functionCalling && <Badge variant="neutral">Tools</Badge>}
            {model.capabilities.vision && <Badge variant="neutral">Vision</Badge>}
            {model.capabilities.reasoning && <Badge variant="info">Reasoning</Badge>}
            {model.capabilities.structuredOutputs && <Badge variant="neutral">Structured</Badge>}
            {model.deprecated && <Badge variant="danger">Deprecated</Badge>}
          </Row>

          <Row justify="between">
            {model.pricing.imagePerImage != null ? (
              <Text variant="muted" size="xs">
                ${String(model.pricing.imagePerImage)}/image
              </Text>
            ) : model.pricing.videoPerSecond != null ? (
              <Text variant="muted" size="xs">
                ${String(model.pricing.videoPerSecond)}/sec
              </Text>
            ) : (
              <>
                <Text variant="muted" size="xs">
                  ${String(model.pricing.promptPer1M)}/1M in
                </Text>
                <Text variant="muted" size="xs">
                  ${String(model.pricing.completionPer1M)}/1M out
                </Text>
              </>
            )}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${String(Math.floor(tokens / 1_000))}K ctx`;
  return `${String(tokens)} ctx`;
}
