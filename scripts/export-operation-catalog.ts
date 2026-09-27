#!/usr/bin/env npx tsx
/**
 * Export Operation Catalog Script
 *
 * Exports operation catalogs in JSON format for use by AI agents and tool calling.
 *
 * Usage:
 *   npx tsx scripts/export-operation-catalog.ts
 *   npx tsx scripts/export-operation-catalog.ts --format operationCatalog --out catalog.json
 *   npx tsx scripts/export-operation-catalog.ts --stepTypes ai,api --tags integration
 *
 * Options:
 *   --stepTypes <types>     Comma-separated list of step types (e.g., "ai,api,user")
 *   --operationIds <ids>    Comma-separated list of operation IDs (e.g., "ai.generate,api.http.call")
 *   --tags <tags>           Comma-separated list of tags (e.g., "integration,crud")
 *   --format <format>       Output format: "operationCatalog" (default) or "toolCatalog"
 *   --strictness <mode>     Tool catalog strictness: "lenient" (default), "strictTopLevel", "strictAll"
 *   --out <path>            Output file path (default: stdout)
 *   --includeOutputSchema   Include output schemas (default: true)
 *   --noIncludeOutputSchema Exclude output schemas
 */

import { writeFileSync } from 'node:fs';
import {
  getOperationCatalog,
  serializeOperationCatalog,
  getToolCatalog,
  serializeToolCatalog,
  type ToolCatalogStrictness,
} from '@aflow/schemas/catalog';

// Parse command line arguments
function parseArgs(): {
  stepTypes?: string[];
  operationIds?: string[];
  tags?: string[];
  format: 'operationCatalog' | 'toolCatalog';
  strictness?: ToolCatalogStrictness;
  out?: string;
  includeOutputSchema: boolean;
} {
  const args = process.argv.slice(2);
  const result: {
    stepTypes?: string[];
    operationIds?: string[];
    tags?: string[];
    format: 'operationCatalog' | 'toolCatalog';
    strictness?: ToolCatalogStrictness;
    out?: string;
    includeOutputSchema: boolean;
  } = {
    format: 'operationCatalog',
    includeOutputSchema: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--stepTypes':
        if (nextArg) {
          result.stepTypes = nextArg.split(',').map((s) => s.trim());
          i++;
        }
        break;
      case '--operationIds':
        if (nextArg) {
          result.operationIds = nextArg.split(',').map((s) => s.trim());
          i++;
        }
        break;
      case '--tags':
        if (nextArg) {
          result.tags = nextArg.split(',').map((s) => s.trim());
          i++;
        }
        break;
      case '--format':
        if (nextArg && (nextArg === 'operationCatalog' || nextArg === 'toolCatalog')) {
          result.format = nextArg;
          i++;
        }
        break;
      case '--strictness':
        if (
          nextArg &&
          (nextArg === 'lenient' || nextArg === 'strictTopLevel' || nextArg === 'strictAll')
        ) {
          result.strictness = nextArg;
          i++;
        }
        break;
      case '--out':
        if (nextArg) {
          result.out = nextArg;
          i++;
        }
        break;
      case '--includeOutputSchema':
        result.includeOutputSchema = true;
        break;
      case '--noIncludeOutputSchema':
        result.includeOutputSchema = false;
        break;
      case '--help':
      case '-h':
        console.log(`
Export Operation Catalog

Usage:
  npx tsx scripts/export-operation-catalog.ts [options]

Options:
  --stepTypes <types>        Comma-separated list of step types
  --operationIds <ids>       Comma-separated list of operation IDs
  --tags <tags>              Comma-separated list of tags
  --format <format>          Output format: operationCatalog (default) or toolCatalog
  --strictness <mode>        Tool catalog strictness: lenient (default), strictTopLevel, strictAll
  --out <path>               Output file path (default: stdout)
  --includeOutputSchema      Include output schemas (default: true)
  --noIncludeOutputSchema    Exclude output schemas
  --help, -h                 Show this help message

Examples:
  # Export all operations as OperationCatalog
  npx tsx scripts/export-operation-catalog.ts

  # Export only AI and API operations
  npx tsx scripts/export-operation-catalog.ts --stepTypes ai,api

  # Export as ToolCatalog with strict top-level schemas
  npx tsx scripts/export-operation-catalog.ts --format toolCatalog --strictness strictTopLevel

  # Export to file
  npx tsx scripts/export-operation-catalog.ts --out catalog.json
`);
        process.exit(0);
        break;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  try {
    let json: string;

    if (args.format === 'toolCatalog') {
      const catalog = getToolCatalog({
        stepTypes: args.stepTypes,
        operationIds: args.operationIds,
        tags: args.tags,
        strictness: args.strictness ?? 'lenient',
      });
      json = serializeToolCatalog(catalog);
      console.error(`Generated ToolCatalog with ${catalog.tools.length} tools`);
    } else {
      const catalog = getOperationCatalog({
        stepTypes: args.stepTypes,
        operationIds: args.operationIds,
        tags: args.tags,
        includeOutputSchema: args.includeOutputSchema,
      });
      json = serializeOperationCatalog(catalog);
      console.error(`Generated OperationCatalog with ${catalog.operations.length} operations`);
    }

    if (args.out) {
      writeFileSync(args.out, json, 'utf-8');
      console.error(`✅ Catalog written to ${args.out}`);
    } else {
      console.log(json);
    }
  } catch (error) {
    console.error('❌ Error generating catalog:', error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(console.error);
