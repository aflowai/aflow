/**
 * @vitest-environment jsdom
 */
/**
 * The inline surface card for a generation that produced no surface says
 * why, rather than "(no mutations)" — which reads as an empty chart.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers.js', () => ({ useApi: () => ({ spaceId: null }) }));
vi.mock('../../hooks/use-artifact-version-view.js', () => ({
  useArtifactVersionView: () => ({ data: null, error: null }),
}));
vi.mock('../artifact-renderer.js', () => ({
  ArtifactRenderer: () => null,
  ARTIFACT_MIN_HEIGHT: 0,
}));
vi.mock('../applet-instance-view.js', () => ({ AppletInstanceView: () => null }));
vi.mock('../mount-when-near.js', () => ({ MountWhenNear: () => null }));
vi.mock('../surface-renderer/index.js', () => ({
  SurfaceRenderer: ({ mutations }: { mutations: unknown[] }) =>
    createElement('div', { 'data-testid': 'surface' }, `${String(mutations.length)} mutations`),
}));

const { InlineSurfaceCard } = await import('./InlineUiCards.js');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(item: Parameters<typeof InlineSurfaceCard>[0]['item']): void {
  act(() => {
    root.render(createElement(InlineSurfaceCard, { item }));
  });
}

const BASE = { itemId: 'session:1', surfaceId: 'surface-d5fc3bc7', isStreaming: false };

describe('InlineSurfaceCard', () => {
  it('shows the generation error instead of "(no mutations)"', () => {
    const error =
      'Surface surface-d5fc3bc7 was not rendered: no valid createSurface mutation ' +
      '(1 generation error(s): Invalid JSON).';
    render({ ...BASE, mutations: [], error });

    expect(container.textContent).toContain(error);
    expect(container.textContent).not.toContain('(no mutations)');
    expect(container.querySelector('[data-testid="surface"]')).toBeNull();
  });

  it('renders the surface when mutations arrived', () => {
    render({ ...BASE, mutations: [{ type: 'createSurface', surfaceId: BASE.surfaceId }] });

    expect(container.querySelector('[data-testid="surface"]')?.textContent).toBe('1 mutations');
  });
});
