/**
 * Applet-specific prompt building and template generation.
 *
 * Applets are standalone HTML/CSS/JS mini-apps. The model sees the full
 * library menu, picks what it needs, and declares them in the JSON output.
 * The wrapper then injects the appropriate script tags.
 */
import { type AppletLibrary, APPLET_LIBRARY_REGISTRY } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Library menu for prompt
// ---------------------------------------------------------------------------

function buildLibraryMenu(): string {
  const lines: string[] = [];
  for (const entry of Object.values(APPLET_LIBRARY_REGISTRY)) {
    const access =
      entry.loading === 'umd'
        ? `global: window.${entry.global}`
        : `import: import * as ${(entry.specifier ?? entry.id).replace(/[^a-zA-Z]/g, '')} from '${entry.specifier ?? entry.id}'`;
    lines.push(`  ${entry.id} (v${entry.version}): ${entry.promptHint} — ${access}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildAppletSystemPrompt(
  libraries: AppletLibrary[],
  componentName: string,
  _requireSampleData: boolean,
): string {
  const preselected =
    libraries.length > 0
      ? `\nPRE-SELECTED LIBRARIES (the user specifically requested these): ${libraries.join(', ')}\nYou should use these. You may also add others from the menu if needed.`
      : '';

  return `You are a creative applet generator. You build standalone interactive HTML/CSS/JS mini-applications.

YOUR CODE RUNS INSIDE A WRAPPER that provides:
- A <script type="module"> block where your code executes
- Full viewport body (100% width/height, box-sizing border-box, system font)
- Theme CSS variables: var(--ds-bg-surface), var(--ds-text-primary), var(--ds-text-muted), etc.
- Host protocol (resize reporting, error forwarding, theme sync)
- CSP that blocks all network (fetch, XHR, WebSocket) — everything must be inline
- Sandboxed iframe — no parent access, no cookies, no localStorage

Your code has access to document.body and can create/append DOM elements freely.
To add CSS, create a <style> element and append it to document.head.

AVAILABLE LIBRARIES (the wrapper will load whichever you declare):
${buildLibraryMenu()}
${preselected}
Declare which libraries you need in the "libraries" field of your response.
UMD libraries will be loaded via <script src> before your code runs (available as globals).
ESM libraries will be added to an import map (use import statements in your code).

OUTPUT FORMAT — respond with a JSON object:
{
  "code": "your JavaScript code that runs inside <script type=\\"module\\">",
  "name": "${componentName}",
  "description": "one-line description",
  "libraries": ["lib1", "lib2"]
}

The "code" field is your applet logic — DOM creation, event handlers, animations, game loops, etc.
Do NOT include <!DOCTYPE html>, <html>, <head>, <body>, or <script> tags — the wrapper handles that.

VISUAL QUALITY (this is critical — aim for portfolio-grade, not prototype):
- Dark themes with depth: use layered backgrounds (gradients, glassmorphism, subtle patterns)
- Rich color palettes: avoid flat single colors. Use gradients, color stops, accent highlights
- Shadows and depth: box-shadow for elevation, text-shadow for glow effects, layered z-index
- Smooth transitions on EVERYTHING interactive: hover states (scale, glow, color shift), click feedback (press effect), focus rings
- Micro-interactions: buttons should feel alive (hover lift + shadow grow, active press), inputs should respond to focus
- Typography: use font-weight contrast (300 vs 700), letter-spacing for headings, line-height for readability
- Spacing: generous padding, consistent gaps, breathing room between elements
- Border radius: use rounded corners consistently (12-24px for containers, 8-12px for buttons, 50% for avatars)
- Animations: smooth easing (cubic-bezier), appropriate duration (150-300ms for micro, 500ms+ for major transitions)
- Polish details: subtle backdrop-filter blur, semi-transparent overlays, gradient borders, icon consistency

INTERACTIVITY:
- State management: maintain clean state, update UI reactively
- Feedback: every user action should have immediate visual feedback
- Error states: handle edge cases gracefully with helpful messages
- Loading states: show spinners or skeleton screens during async operations
- Responsive: adapt layout for different viewport sizes (use CSS grid/flexbox, clamp(), min/max)

CODE QUALITY:
- Create elements and append to document.body
- Add CSS via a style element appended to document.head
- Fill the viewport — body is already 100% width/height
- Use requestAnimationFrame for animations, clean up on unload
- Handle resize for responsive behavior
- Organize code: setup → state → render → event handlers → game loop

SECURITY:
- No eval(), no new Function()
- No fetch/XHR (CSP blocks it)

IMPORTANT: Respond ONLY with the JSON object. No markdown, no code fences, no explanation.`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export function buildAppletUserPrompt(
  prompt: string,
  libraries: AppletLibrary[],
  dataSchema: Record<string, unknown>,
  previewData?: Record<string, unknown>,
  styleGuidance?: string,
): string {
  let userPrompt = `Create an interactive applet:\n\n${prompt}`;

  if (libraries.length > 0) {
    userPrompt += `\n\nRequested libraries: ${libraries.join(', ')}`;
  }

  if (Object.keys(dataSchema).length > 0) {
    userPrompt += `\n\nExpected data shape:\n${JSON.stringify(dataSchema, null, 2)}`;
  }

  if (previewData) {
    userPrompt += `\n\nSample data:\n${JSON.stringify(previewData, null, 2)}`;
  }

  if (styleGuidance) {
    userPrompt += `\n\nStyle guidance:\n${styleGuidance}`;
  }

  return userPrompt;
}

// ---------------------------------------------------------------------------
// Template fallback (no AI provider)
// ---------------------------------------------------------------------------

export function generateAppletTemplateSource(prompt: string, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Applet';
  const safePrompt = prompt.slice(0, 200).replace(/[`\\]/g, '');

  return `// ${safeName} — generated applet template
const container = document.createElement('div');
container.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:var(--ds-text-primary);';
container.innerHTML = \`
  <h2>${safeName}</h2>
  <p style="color:var(--ds-text-muted);max-width:400px;text-align:center">Generated from: ${safePrompt}…</p>
  <p style="margin-top:16px;color:var(--ds-text-muted);font-size:14px">AI generation unavailable — placeholder template.</p>
\`;
document.body.appendChild(container);
`;
}
