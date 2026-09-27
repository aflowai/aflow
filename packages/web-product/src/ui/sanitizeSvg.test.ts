/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from './sanitizeSvg.js';

/**
 * Each entry is markup that must not survive sanitization with its execution
 * vector intact. The assertion is deliberately about the vector rather than
 * the exact output — DOMPurify may keep the surrounding element, and that is
 * fine as long as nothing can run.
 */
const MALICIOUS: { name: string; svg: string; forbidden: string[] }[] = [
  {
    name: 'script element',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    forbidden: ['<script', 'alert(1)'],
  },
  {
    name: 'onload on the root element',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
    forbidden: ['onload'],
  },
  {
    name: 'pointer event handler outside the legacy denylist',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect onpointerenter="alert(1)" width="10" height="10"/></svg>',
    forbidden: ['onpointerenter'],
  },
  {
    name: 'javascript: URL in an anchor',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
    forbidden: ['javascript:'],
  },
  {
    name: 'javascript: URL in xlink:href',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    forbidden: ['javascript:'],
  },
  {
    name: 'foreignObject smuggling HTML',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src=x onerror="alert(1)"/></foreignObject></svg>',
    forbidden: ['foreignObject', 'onerror'],
  },
  {
    name: 'animate re-pointing an href to a script URL',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>',
    forbidden: ['javascript:'],
  },
  {
    name: 'set element writing an event handler',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect><set attributeName="onmouseover" to="alert(1)"/></rect></svg>',
    forbidden: ['onmouseover'],
  },
  {
    name: 'html entity encoded handler',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect on&#x63;lick="alert(1)"/></svg>',
    forbidden: ['alert(1)'],
  },
  {
    name: 'uppercase attribute name',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK="alert(1)"/></svg>',
    forbidden: ['alert(1)'],
  },
  {
    name: 'malformed tag recovering into a handler',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect <img src=x onerror=alert(1)>/></svg>',
    forbidden: ['onerror'],
  },
  {
    name: 'iframe with a data: document',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="data:text/html,<script>alert(1)</script>"></iframe></svg>',
    forbidden: ['<iframe', '<script'],
  },
  {
    name: 'use element pulling an external document',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
    forbidden: ['evil.example'],
  },
  {
    name: 'base element re-pointing relative URLs',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><base href="https://evil.example/"/><rect/></svg>',
    forbidden: ['<base', 'evil.example'],
  },
];

describe('sanitizeSvg', () => {
  for (const { name, svg, forbidden } of MALICIOUS) {
    it(`neutralizes ${name}`, () => {
      const clean = sanitizeSvg(svg).toLowerCase();
      for (const needle of forbidden) {
        expect(clean).not.toContain(needle.toLowerCase());
      }
    });
  }

  // Not script execution, but a remote reference reports who opened the
  // document and when. The generator already forbids them; this makes the
  // render boundary enforce it rather than trust it.
  describe('external references', () => {
    const EXTERNAL: [string, string][] = [
      [
        'image href',
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/b.png"/></svg>',
      ],
      [
        'image xlink:href',
        '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="https://evil.example/b.png"/></svg>',
      ],
      [
        'feImage href',
        '<svg xmlns="http://www.w3.org/2000/svg"><filter><feImage href="https://evil.example/b.png"/></filter></svg>',
      ],
      [
        'use href',
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
      ],
      [
        'protocol-relative url',
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.example/b.png"/></svg>',
      ],
      [
        'css @import',
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);</style><rect/></svg>',
      ],
      [
        'css url()',
        '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.example/x)}</style><rect/></svg>',
      ],
    ];

    for (const [name, svg] of EXTERNAL) {
      it(`strips ${name}`, () => {
        expect(sanitizeSvg(svg).toLowerCase()).not.toContain('evil.example');
      });
    }

    it('keeps an inline data image', () => {
      const clean = sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">' +
          '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
      );
      expect(clean).toContain('data:image/png;base64');
    });

    it('keeps a fragment reference in a paint-server attribute', () => {
      const clean = sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">' +
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<rect fill="url(#g)" width="4" height="4"/></svg>',
      );
      expect(clean).toContain('url(#g)');
    });

    // `use` is on DOMPurify's SVG-profile deny list precisely because it
    // resolves external documents. Dropping the element is stricter than
    // stripping its href, so this records the behaviour rather than
    // re-enabling the tag to preserve a reference style.
    it('drops <use> entirely, external or not', () => {
      const clean = sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><circle id="c" r="2"/></defs><use href="#c"/></svg>',
      );
      expect(clean).not.toContain('<use');
    });
  });

  it('keeps the style blocks illustrations use for theming and animation', () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">' +
        '<style>:root{--ill-accent:#3b82f6}@keyframes spin{to{transform:rotate(360deg)}}' +
        '.dot{fill:var(--ill-accent);animation:spin 2s linear infinite}</style>' +
        '<circle class="dot" r="1"/></svg>',
    );

    expect(clean).toContain('@keyframes');
    expect(clean).toContain('--ill-accent');
    expect(clean).toContain('var(--ill-accent)');
  });

  it('preserves benign illustration markup', () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
        '<title>Chart</title><g transform="translate(2,2)">' +
        '<path d="M0 0 L10 10" stroke="currentColor" stroke-width="2" fill="url(#g)"/>' +
        '<circle cx="5" cy="5" r="3" style="opacity:0.5"/>' +
        '<text x="1" y="2" font-size="4">hi</text></g></svg>',
    );

    expect(clean).toContain('<svg');
    expect(clean).toContain('linearGradient');
    expect(clean).toContain('<path');
    expect(clean).toContain('stroke="currentColor"');
    expect(clean).toContain('<circle');
    expect(clean).toContain('<text');
  });

  it('is idempotent', () => {
    const once = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()"/></svg>');
    expect(sanitizeSvg(once)).toBe(once);
  });

  it('returns empty string when the input carries no svg root', () => {
    expect(sanitizeSvg('<div>not an illustration</div>')).toBe('');
    expect(sanitizeSvg('')).toBe('');
  });
});
