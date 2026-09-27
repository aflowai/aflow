#!/usr/bin/env tsx
/**
 * Token Build Script
 *
 * Reads tokens.json and generates:
 * - src/tokens.css (CSS custom properties with v1 backward-compat aliases)
 * - src/tokens.ts (TypeScript types and helpers)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '../tokens/tokens.json');
const CSS_OUTPUT = path.join(__dirname, '../src/tokens.css');
const TS_OUTPUT = path.join(__dirname, '../src/tokens.ts');

interface StatusTokens {
  fg: string;
  bg: string;
}

interface ColorTheme {
  surface: Record<string, string>;
  content: Record<string, string>;
  border: Record<string, string>;
  interactive: Record<string, string>;
  highlight: Record<string, string>;
  status: Record<string, StatusTokens>;
  focus: Record<string, string>;
  danger: Record<string, string>;
  warning: Record<string, string>;
  success: Record<string, string>;
  info: Record<string, string>;
  accent: Record<string, string>;
  data: Record<string, string>;
}

interface Tokens {
  color: {
    light: ColorTheme;
    dark: ColorTheme;
  };
  space: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  font: {
    family: Record<string, string>;
    size: Record<string, string>;
    weight: Record<string, string>;
    lineHeight: Record<string, string>;
    letterSpacing?: Record<string, string>;
  };
  zIndex: Record<string, string>;
  transition: {
    duration: Record<string, string>;
    timing: Record<string, string>;
  };
  layout: Record<string, string>;
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function flattenColorTheme(theme: ColorTheme, prefix: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [category, values] of Object.entries(theme)) {
    if (category === 'status') {
      // Status tokens are nested: { queued: { fg, bg }, running: { fg, bg }, ... }
      for (const [statusName, statusValues] of Object.entries(
        values as Record<string, StatusTokens>,
      )) {
        const sv = statusValues;
        result[`${prefix}-status-${statusName}-fg`] = sv.fg;
        result[`${prefix}-status-${statusName}-bg`] = sv.bg;
      }
    } else {
      for (const [key, value] of Object.entries(values as Record<string, string>)) {
        if (key.startsWith('$')) continue; // skip $description etc.
        const kebabKey = toKebabCase(key);
        result[`${prefix}-${toKebabCase(category)}-${kebabKey}`] = value;
      }
    }
  }

  return result;
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;

    const newKey = prefix ? `${prefix}-${toKebabCase(key)}` : toKebabCase(key);

    if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
    } else if (typeof value === 'string') {
      result[newKey] = value;
    }
  }

  return result;
}

/** Generate backward-compatible v1 aliases that map old names to new CSS vars */
function generateV1Aliases(theme: ColorTheme): Record<string, string> {
  const aliases: Record<string, string> = {};

  // surface.0/1/2/3 → surface.canvas/raised/overlay/sunken
  const surfaceMap: Record<string, string> = {
    '0': 'canvas',
    '1': 'raised',
    '2': 'overlay',
    '3': 'sunken',
  };
  for (const [oldKey, newKey] of Object.entries(surfaceMap)) {
    aliases[`--color-surface-${oldKey}`] = `var(--color-surface-${newKey})`;
  }

  // text.* → content.*
  for (const key of Object.keys(theme.content)) {
    aliases[`--color-text-${toKebabCase(key)}`] = `var(--color-content-${toKebabCase(key)})`;
  }

  // status flat → status nested (running/runningBg → status-running-fg/bg)
  for (const statusName of Object.keys(theme.status)) {
    aliases[`--color-status-${statusName}`] = `var(--color-status-${statusName}-fg)`;
    // Do not alias --color-status-{name}-bg to itself: that overwrites the real value with a
    // cyclic var() and breaks background-color on web. Keep only --color-status-{name}Bg (v1).
    aliases[`--color-status-${statusName}Bg`] = `var(--color-status-${statusName}-bg)`;
  }

  // danger/warning/success/info/accent .text → .fg
  for (const category of ['danger', 'warning', 'success', 'info', 'accent', 'highlight'] as const) {
    aliases[`--color-${category}-text`] = `var(--color-${category}-fg)`;
  }

  return aliases;
}

function generateCSS(tokens: Tokens): string {
  const lines: string[] = [];

  lines.push('/* ==========================================================================');
  lines.push('   Phoenix Design System - Generated CSS Custom Properties');
  lines.push('   DO NOT EDIT DIRECTLY - Generated from tokens/tokens.json');
  lines.push('   ========================================================================== */');
  lines.push('');

  // Light theme (default)
  lines.push(":root, [data-theme='light'] {");
  const lightColors = flattenColorTheme(tokens.color.light, 'color');
  for (const [key, value] of Object.entries(lightColors)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('');
  lines.push('  /* v1 backward-compat aliases — remove after migration */');
  const lightAliases = generateV1Aliases(tokens.color.light);
  for (const [alias, target] of Object.entries(lightAliases)) {
    lines.push(`  ${alias}: ${target};`);
  }
  lines.push('}');
  lines.push('');

  // Dark theme
  lines.push("[data-theme='dark'] {");
  const darkColors = flattenColorTheme(tokens.color.dark, 'color');
  for (const [key, value] of Object.entries(darkColors)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('');
  lines.push('  /* v1 backward-compat aliases — remove after migration */');
  const darkAliases = generateV1Aliases(tokens.color.dark);
  for (const [alias, target] of Object.entries(darkAliases)) {
    lines.push(`  ${alias}: ${target};`);
  }
  lines.push('}');
  lines.push('');

  // System preference dark mode
  lines.push('@media (prefers-color-scheme: dark) {');
  lines.push("  :root:not([data-theme='light']) {");
  for (const [key, value] of Object.entries(darkColors)) {
    lines.push(`    --${key}: ${value};`);
  }
  lines.push('');
  lines.push('    /* v1 backward-compat aliases */');
  for (const [alias, target] of Object.entries(darkAliases)) {
    lines.push(`    ${alias}: ${target};`);
  }
  lines.push('  }');
  lines.push('}');
  lines.push('');

  // Space
  lines.push('/* Spacing */');
  lines.push(':root {');
  const spaces = flattenObject(tokens.space, 'space');
  for (const [key, value] of Object.entries(spaces)) {
    lines.push(`  --${key}: ${value};`);
  }
  // Numeric space values are included in the source token file for backward compat
  lines.push('}');
  lines.push('');

  // Radius
  lines.push('/* Border Radius */');
  lines.push(':root {');
  const radii = flattenObject(tokens.radius, 'radius');
  for (const [key, value] of Object.entries(radii)) {
    lines.push(`  --${key}: ${value};`);
  }
  // v1 aliases
  lines.push('  --radius-2xl: 32px;');
  lines.push('  --radius-round: var(--radius-full);');
  lines.push('}');
  lines.push('');

  // Shadow
  lines.push('/* Shadows */');
  lines.push(':root {');
  const shadows = flattenObject(tokens.shadow, 'shadow');
  for (const [key, value] of Object.entries(shadows)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');

  // Font
  lines.push('/* Typography */');
  lines.push(':root {');
  const fonts = flattenObject(tokens.font, 'font');
  for (const [key, value] of Object.entries(fonts)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');

  // Z-Index
  lines.push('/* Z-Index */');
  lines.push(':root {');
  const zIndexes = flattenObject(tokens.zIndex, 'z');
  for (const [key, value] of Object.entries(zIndexes)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');

  // Transitions
  lines.push('/* Transitions */');
  lines.push(':root {');
  const transitions = flattenObject(tokens.transition, 'transition');
  for (const [key, value] of Object.entries(transitions)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');

  // Breakpoints
  lines.push('/* Breakpoints */');
  lines.push(':root {');
  lines.push('  --breakpoint-sm: 640px;');
  lines.push('  --breakpoint-md: 768px;');
  lines.push('  --breakpoint-lg: 1024px;');
  lines.push('  --breakpoint-xl: 1280px;');
  lines.push('}');
  lines.push('');

  // Layout (content width, etc.)
  lines.push('/* Layout */');
  lines.push(':root {');
  const layouts = flattenObject(tokens.layout, 'layout');
  for (const [key, value] of Object.entries(layouts)) {
    lines.push(`  --${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function generateTS(tokens: Tokens): string {
  const lines: string[] = [];

  lines.push('/* ==========================================================================');
  lines.push('   Phoenix Design System - Generated TypeScript Token Helpers');
  lines.push('   DO NOT EDIT DIRECTLY - Generated from tokens/tokens.json');
  lines.push('   ========================================================================== */');
  lines.push('');

  // Space token type
  const spaceKeys = Object.keys(tokens.space).filter((k) => !k.startsWith('$'));
  lines.push(`export type SpaceToken = ${spaceKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Radius
  const radiusKeys = Object.keys(tokens.radius).filter((k) => !k.startsWith('$'));
  lines.push(`export type RadiusToken = ${radiusKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Shadow
  const shadowKeys = Object.keys(tokens.shadow).filter((k) => !k.startsWith('$'));
  lines.push(`export type ShadowToken = ${shadowKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Font size
  const fontSizeKeys = Object.keys(tokens.font.size);
  lines.push(`export type FontSizeToken = ${fontSizeKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Font weight
  const fontWeightKeys = Object.keys(tokens.font.weight);
  lines.push(`export type FontWeightToken = ${fontWeightKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Z-index
  const zIndexKeys = Object.keys(tokens.zIndex).filter((k) => !k.startsWith('$'));
  lines.push(`export type ZIndexToken = ${zIndexKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Color categories
  const colorCategories = Object.keys(tokens.color.light);
  lines.push(`export type ColorCategory = ${colorCategories.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');

  // Token accessor helpers
  lines.push('// Token accessor helpers');
  lines.push(`export function space(value: SpaceToken): string {`);
  lines.push(`  return \`var(--space-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function radius(value: RadiusToken): string {`);
  lines.push(`  return \`var(--radius-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function shadow(value: ShadowToken): string {`);
  lines.push(`  return \`var(--shadow-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function fontSize(value: FontSizeToken): string {`);
  lines.push(`  return \`var(--font-size-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function fontWeight(value: FontWeightToken): string {`);
  lines.push(`  return \`var(--font-weight-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function zIndex(value: ZIndexToken): string {`);
  lines.push(`  return \`var(--z-\${value})\`;`);
  lines.push(`}`);
  lines.push('');

  // Color helper
  lines.push('// Color token helper');
  lines.push('type ColorPath = ');
  for (const category of colorCategories) {
    const vals = tokens.color.light[category as keyof ColorTheme];
    if (category === 'status') {
      for (const statusName of Object.keys(vals as Record<string, StatusTokens>)) {
        lines.push(`  | "status.${statusName}.fg"`);
        lines.push(`  | "status.${statusName}.bg"`);
      }
    } else {
      for (const subKey of Object.keys(vals as Record<string, string>)) {
        lines.push(`  | "${category}.${subKey}"`);
      }
    }
  }
  lines.push(';');
  lines.push('');

  lines.push(`export function color(path: ColorPath): string {`);
  lines.push(`  const cssVar = path.replace(/\\./g, "-");`);
  lines.push(`  return \`var(--color-\${cssVar})\`;`);
  lines.push(`}`);
  lines.push('');

  // Breakpoint tokens
  lines.push('// Breakpoint tokens');
  lines.push(`export type BreakpointToken = "sm" | "md" | "lg" | "xl";`);
  lines.push('');
  lines.push(`export const breakpoints: Record<BreakpointToken, number> = {`);
  lines.push(`  sm: 640,`);
  lines.push(`  md: 768,`);
  lines.push(`  lg: 1024,`);
  lines.push(`  xl: 1280,`);
  lines.push(`};`);
  lines.push('');

  // Layout tokens
  const layoutKeys = Object.keys(tokens.layout).filter((k) => !k.startsWith('$'));
  lines.push(`export type LayoutToken = ${layoutKeys.map((k) => `"${k}"`).join(' | ')};`);
  lines.push('');
  lines.push(`export function layout(value: LayoutToken): string {`);
  lines.push(`  const map = {`);
  for (const key of layoutKeys) {
    lines.push(
      `    ${JSON.stringify(key)}: ${JSON.stringify(`var(--layout-${toKebabCase(key)})`)},`,
    );
  }
  lines.push(`  } as const satisfies Record<LayoutToken, string>;`);
  lines.push(`  return map[value];`);
  lines.push(`}`);
  lines.push('');

  // Theme helper
  lines.push('// Theme helper');
  lines.push(`export type Theme = "light" | "dark" | "system";`);
  lines.push('');
  lines.push(`export function setTheme(theme: Theme): void {`);
  lines.push(`  if (typeof document === "undefined") return;`);
  lines.push(`  if (theme === "system") {`);
  lines.push(`    document.documentElement.removeAttribute("data-theme");`);
  lines.push(`  } else {`);
  lines.push(`    document.documentElement.setAttribute("data-theme", theme);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export function getTheme(): Theme {`);
  lines.push(`  if (typeof document === "undefined") return "system";`);
  lines.push(
    `  return (document.documentElement.getAttribute("data-theme") as Theme) ?? "system";`,
  );
  lines.push(`}`);
  lines.push('');

  // Raw token values
  lines.push('// Raw token values (for reference/tooling)');
  lines.push(`export const tokens = ${JSON.stringify(tokens, null, 2)} as const;`);
  lines.push('');

  return lines.join('\n');
}

// Main execution
const tokensRaw = fs.readFileSync(TOKENS_PATH, 'utf-8');
const tokens = JSON.parse(tokensRaw) as Tokens;

const css = generateCSS(tokens);
const ts = generateTS(tokens);

fs.writeFileSync(CSS_OUTPUT, css);
fs.writeFileSync(TS_OUTPUT, ts);

console.log('✓ Generated src/tokens.css');
console.log('✓ Generated src/tokens.ts');
