/**
 * Illustration-specific prompt building and template generation.
 *
 * Illustrations are pure SVG with CSS/SMIL animations — no JavaScript.
 * Quality exemplars: icecream.svg (loaders), frog.svg (character animations).
 */
import type { IllustrationConfig } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Purpose-specific guidance
// ---------------------------------------------------------------------------

const PURPOSE_GUIDANCE: Record<string, string> = {
  loader:
    'This is a LOADING INDICATOR. It should loop smoothly and infinitely. ' +
    'Keep it visually lightweight — the user will stare at this while waiting. ' +
    'Think: floating objects, orbiting elements, pulsing shapes, gentle rotations. ' +
    'Reference pattern: ice cream floating on an elliptical path with melting drips.',
  error:
    'This is an ERROR STATE illustration. It should convey "something went wrong" with personality and humor. ' +
    'The mood should be sympathetic, not alarming. Think: a character reacting to a mishap, broken objects, ' +
    'comical failure. Reference pattern: a frog catching a fly with synchronized eye/tongue/mouth animation.',
  avatar:
    'This is an AVATAR or profile image. It should be iconic, recognizable at small sizes, ' +
    'and work well as a circle crop. Keep detail minimal — bold shapes, clear silhouette. ' +
    'Subtle idle animation is fine (breathing, blinking) but optional.',
  decorative:
    'This is a DECORATIVE illustration for visual interest. It should enhance the page without ' +
    'demanding attention. Think: abstract patterns, flowing shapes, ambient motion.',
  badge:
    'This is a BADGE or status indicator. Very small display size — must read clearly at 24-48px. ' +
    'Bold, simple shapes only. Minimal or no animation. High contrast.',
  icon:
    'This is an ICON. Must work at 16-32px. Extremely simple — 1-2 shapes, solid fills, no gradients. ' +
    'No animation. Crisp lines, pixel-aligned strokes.',
  hero:
    'This is a HERO illustration — the main visual on a page. It should be detailed, expressive, ' +
    'and tell a story. Rich animation is encouraged. Fill the viewport with personality.',
};

const ANIMATION_GUIDANCE: Record<string, string> = {
  none: 'Do NOT include any animation. Static SVG only.',
  subtle:
    'Include SUBTLE animation — gentle floating, slow pulsing, soft breathing effects. ' +
    'Use long durations (4-8s), ease-in-out timing, and small transform ranges.',
  playful:
    'Include PLAYFUL animation — bouncing, wiggling, spinning elements. Multiple coordinated animations. ' +
    'Use medium durations (2-6s), varied timing functions, and moderate transform ranges.',
  complex:
    'Include COMPLEX, narrative animation — multiple synchronized stages, character actions, ' +
    'state transitions. Use keyTimes for precise multi-stage coordination. ' +
    'Shared cycle duration across all animated elements for coherence.',
};

const SIZE_GUIDANCE: Record<string, string> = {
  xs: 'Target display: 24-32px. Extremely simple. 1-3 shapes maximum.',
  sm: 'Target display: 48-64px. Simple but recognizable. Limited detail.',
  md: 'Target display: 96-128px. Moderate detail. Good balance of simplicity and expression.',
  lg: 'Target display: 200-300px. Rich detail allowed. Multiple layered elements.',
  xl: 'Target display: 400px+. Full detail. Complex scenes, multiple characters, backgrounds.',
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildIllustrationSystemPrompt(
  config: IllustrationConfig | undefined,
  componentName: string,
  _requireSampleData: boolean,
): string {
  const purpose = config?.purpose ?? 'decorative';
  const animation = config?.animation ?? 'subtle';
  const sizeHint = config?.sizeHint ?? 'md';

  const purposeText = PURPOSE_GUIDANCE[purpose] ?? PURPOSE_GUIDANCE['decorative']!;
  const animationText = ANIMATION_GUIDANCE[animation] ?? ANIMATION_GUIDANCE['subtle']!;
  const sizeText = SIZE_GUIDANCE[sizeHint] ?? SIZE_GUIDANCE['md']!;

  const themeProps = config?.themeProperties ?? ['--primary', '--accent', '--background'];
  const themeSection =
    themeProps.length > 0
      ? `Define these CSS custom properties in a <style> block inside the SVG for theming:\n${themeProps.map((p) => `  ${p}`).join('\n')}\nUse var(${themeProps[0]}) etc. for all colors. Provide sensible defaults.`
      : 'Use CSS custom properties (--primary, --accent, --background) for all colors.';

  return `You are an SVG illustration specialist. You create beautiful, animated SVG illustrations.

OUTPUT FORMAT:
Respond with a JSON object containing exactly these fields:
{
  "code": "<complete SVG element>",
  "name": "${componentName}",
  "description": "<one-line description>"
}

CRITICAL — the "code" field must contain a COMPLETE, self-contained <svg> element:
- Starts with <svg xmlns="http://www.w3.org/2000/svg" viewBox="..." ...> and ends with </svg>
- Everything inline — styles, animations, gradients, all within the SVG

PURPOSE: ${purposeText}

ANIMATION: ${animationText}

SIZE: ${sizeText}

SVG RULES (critical):
- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="..." preserveAspectRatio="xMidYMid meet">
- ALWAYS include a viewBox attribute. NEVER set fixed width/height on the root <svg>.
- Use <defs> for reusable gradients, clip paths, and patterns.
- Include <title>${componentName}</title> and <desc> for accessibility.
- ${themeSection}

ANIMATION TECHNIQUES:
- CSS @keyframes inside <style> for simple transforms and opacity.
- SMIL <animate> for attribute animation (fill, opacity, d path morphing).
- SMIL <animateTransform> for rotate, scale, translate.
- SMIL <animateMotion> with <mpath> for path-following movement.
- Use keyTimes + keyValues for precise multi-stage timing.
- Use a shared dur value (e.g., "6s") across related animations for synchronization.
- Use repeatCount="indefinite" for looping animations.

SECURITY (validation will reject violations):
- NO <script> tags — zero JavaScript.
- NO <foreignObject> elements.
- NO external references (no xlink:href="http://...", no url(http://...) in styles).
- NO event handler attributes (onclick, onload, onerror, etc.).
- All resources must be inline (embedded data URIs for images are fine).

QUALITY:
- Use smooth curves (cubic Bézier) over angular paths.
- Layer elements for depth (background → mid-ground → foreground).
- Add subtle details: shadows, highlights, texture dots.
- Prefer rounded line joins and caps for friendly aesthetics.
- Keep the SVG under 128KB.

IMPORTANT: Respond ONLY with the JSON object. No markdown, no explanation, no code fences.`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export function buildIllustrationUserPrompt(
  prompt: string,
  config: IllustrationConfig | undefined,
  dataSchema: Record<string, unknown>,
  _previewData?: Record<string, unknown>,
  styleGuidance?: string,
): string {
  let userPrompt = `Create an SVG illustration for this request:\n\n${prompt}`;

  const parts: string[] = [];
  if (config?.purpose) parts.push(`Purpose: ${config.purpose}`);
  if (config?.animation) parts.push(`Animation: ${config.animation}`);
  if (config?.sizeHint) parts.push(`Size: ${config.sizeHint}`);
  if (parts.length > 0) {
    userPrompt += `\n\nILLUSTRATION CONFIG: ${parts.join(', ')}`;
  }

  if (config?.themeProperties && config.themeProperties.length > 0) {
    userPrompt += `\n\nTHEME PROPERTIES to define: ${config.themeProperties.join(', ')}`;
  }

  if (Object.keys(dataSchema).length > 0) {
    userPrompt += `\n\nDATA SCHEMA (for parameterizable illustrations):\n${JSON.stringify(dataSchema, null, 2)}`;
  }

  if (styleGuidance) {
    userPrompt += `\n\nSTYLE GUIDANCE:\n${styleGuidance}`;
  }

  return userPrompt;
}

// ---------------------------------------------------------------------------
// Output parsing — extract metadata from comment header
// ---------------------------------------------------------------------------

export interface IllustrationParseResult {
  source: string;
  name?: string;
  description?: string;
}

/** Parse illustration model output — extract metadata comment and clean SVG source. */
export function parseIllustrationOutput(raw: string): IllustrationParseResult {
  let source = raw.trim();

  // Strip markdown fences if the model wrapped it
  source = source.replace(/^```(?:svg|xml)?\s*\n/m, '');
  source = source.replace(/\n```\s*$/m, '');
  source = source.trim();

  // Extract metadata comment: <!-- illustration-meta: {...} -->
  let name: string | undefined;
  let description: string | undefined;
  const metaMatch = /<!--\s*illustration-meta:\s*(\{.*?\})\s*-->/s.exec(source);
  if (metaMatch?.[1]) {
    try {
      const meta = JSON.parse(metaMatch[1]) as Record<string, unknown>;
      if (typeof meta['name'] === 'string') name = meta['name'];
      if (typeof meta['description'] === 'string') description = meta['description'];
    } catch {
      // Ignore
    }
    // Remove the metadata comment from the SVG source
    source = source.replace(/<!--\s*illustration-meta:\s*\{.*?\}\s*-->\s*/s, '').trim();
  }

  return {
    source,
    ...(name != null ? { name } : {}),
    ...(description != null ? { description } : {}),
  };
}

// ---------------------------------------------------------------------------
// Template fallback
// ---------------------------------------------------------------------------

export function generateIllustrationTemplateSvg(prompt: string, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Illustration';
  const safePrompt = prompt.slice(0, 80).replace(/[<>&"]/g, '');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">
  <title>${safeName}</title>
  <desc>${safePrompt}</desc>
  <style>
    :root { --primary: #6366f1; --accent: #ec4899; --background: #f8fafc; }
    .bg { fill: var(--background); }
    .shape { fill: var(--primary); }
    .dot { fill: var(--accent); }
    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
    .floating { animation: float 3s ease-in-out infinite; }
  </style>
  <rect class="bg" width="200" height="200" rx="16" />
  <g class="floating" transform="translate(100, 90)">
    <circle class="shape" r="32" opacity="0.9" />
    <circle class="dot" cx="-10" cy="-8" r="4" />
    <circle class="dot" cx="10" cy="-8" r="4" />
    <path class="dot" d="M-8 6 Q0 14 8 6" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
  </g>
  <text x="100" y="160" text-anchor="middle" font-family="system-ui" font-size="11" fill="var(--primary)" opacity="0.6">${safeName}</text>
</svg>`;
}
