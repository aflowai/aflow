/**
 * Inline handler for design_system.catalog.get
 *
 * Returns the pre-built DesignSystemContractBundle from the design-system
 * package, with optional filtering by mode, categories, and components.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorContextFromUnknown } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Load pre-built contract bundles at module init
// ============================================================================

interface ContractBundle {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  generatedAt: string;
  designSystemVersion: string;
  mode: string;
  components: Array<{
    name: string;
    importPath: string;
    category: string;
    intents: string[];
    description: string;
    props: Array<{
      name: string;
      type: string;
      required: boolean;
      default?: string;
      description: string;
    }>;
    doNot?: string[];
    combinesWith?: string[];
    a11y?: string;
    synonyms?: string[];
    preferOver?: string;
    examples?: string[];
    guidance?: string;
  }>;
  tokens: {
    spaceTokens: string[];
    radiusTokens: string[];
    shadowTokens: string[];
    fontSizeTokens: string[];
    fontWeightTokens: string[];
    colorPaths: string[];
    iconNames: string[];
  };
  libraries: Array<{
    id: string;
    name: string;
    description: string;
    availableInArtifact: boolean;
    availableInSurface: boolean;
  }>;
  surfaceComponents?: string[];
}

let artifactBundle: ContractBundle | null = null;
let surfaceBundle: ContractBundle | null = null;
let compactArtifactBundle: Record<string, unknown> | null = null;
let compactSurfaceBundle: Record<string, unknown> | null = null;

function loadBundles(): void {
  if (artifactBundle) return;

  // Resolve from the design-system package dist directory.
  // In monorepo dev, the compiled dist/ is the source of truth.
  const dsDistDir = resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'design-system',
    'dist',
  );

  try {
    artifactBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract.json'), 'utf-8'),
    ) as ContractBundle;
    surfaceBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-surface.json'), 'utf-8'),
    ) as ContractBundle;
    compactArtifactBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-compact.json'), 'utf-8'),
    ) as Record<string, unknown>;
    compactSurfaceBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-compact-surface.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch (err) {
    getOrchestratorLogger().error(
      '[designSystemCatalog] Failed to load contract bundles',
      err instanceof Error ? err : undefined,
      errorContextFromUnknown(err, {
        component: 'design-system-catalog',
        phase: 'loadBundles',
      }),
    );
    throw new Error(
      'Design system contract bundles not found. Run `yarn workspace @aflow/design-system build` first.',
    );
  }
}

// ============================================================================
// Handler
// ============================================================================

export async function handleDesignSystemCatalogGetInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  try {
    loadBundles();

    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input — return full catalog */
    }

    const mode = (input['mode'] as string | undefined) ?? 'artifact';
    const categories = input['categories'] as string[] | undefined;
    const componentFilter = input['components'] as string[] | undefined;
    const libraryFilter = input['libraries'] as string[] | undefined;
    const includeTokens = input['includeTokens'] !== false;
    const includeExamples = input['includeExamples'] !== false;
    const compact = input['compact'] === true;

    // Select base bundle
    if (compact) {
      const base = mode === 'surface' ? compactSurfaceBundle! : compactArtifactBundle!;
      await emitStepSuccess(args, { bundle: base }, startTime);
      return;
    }

    const base = mode === 'surface' ? surfaceBundle! : artifactBundle!;

    // Apply filters
    let components = base.components;
    if (categories && categories.length > 0) {
      const catSet = new Set(categories);
      components = components.filter((c) => catSet.has(c.category));
    }
    if (componentFilter && componentFilter.length > 0) {
      const nameSet = new Set(componentFilter);
      components = components.filter((c) => nameSet.has(c.name));
    }

    // Strip examples if not requested
    if (!includeExamples) {
      components = components.map((c) => {
        const { examples: _e, guidance: _g, ...rest } = c;
        return rest;
      });
    }

    // Filter libraries
    let libraries = base.libraries;
    if (libraryFilter && libraryFilter.length > 0) {
      const libSet = new Set(libraryFilter);
      libraries = libraries.filter((l) => libSet.has(l.id));
    }

    const result: Record<string, unknown> = {
      catalogId: base.catalogId,
      catalogVersion: base.catalogVersion,
      catalogHash: base.catalogHash,
      generatedAt: base.generatedAt,
      designSystemVersion: base.designSystemVersion,
      mode: base.mode,
      components,
      libraries,
    };

    if (includeTokens) {
      result['tokens'] = base.tokens;
    }

    if (base.surfaceComponents) {
      result['surfaceComponents'] = base.surfaceComponents;
    }

    await emitStepSuccess(args, { bundle: result }, startTime);

    getOrchestratorLogger().debug(
      `[designSystemCatalog] design_system.catalog.get inline: ${String(components.length)} components (mode=${mode})`,
    );
  } catch (err) {
    await emitStepError(
      args,
      'DS_CATALOG_GET_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'configuration',
    );
  }
}
