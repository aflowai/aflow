import { describe, it, expect } from 'vitest';
import { renderEmailContent } from '../email/render.js';

describe('renderEmailContent', () => {
  describe('markdown format', () => {
    it('renders basic markdown to HTML', async () => {
      const result = await renderEmailContent('**Hello** world', 'markdown');

      expect(result.html).toContain('Hello</strong> world');
      expect(result.html).toContain('<!DOCTYPE html>');
      expect(result.html).toContain('aflow');
    });

    it('renders headings', async () => {
      const result = await renderEmailContent('# Title\n\nSome text', 'markdown');

      expect(result.html).toContain('<h1');
      expect(result.html).toContain('Title</h1>');
      expect(result.text.toLowerCase()).toContain('title');
    });

    it('renders lists', async () => {
      const md = '- Item 1\n- Item 2\n- Item 3';
      const result = await renderEmailContent(md, 'markdown');

      expect(result.html).toContain('Item 1</li>');
      expect(result.text).toContain('Item 1');
    });

    it('renders links', async () => {
      const result = await renderEmailContent('[Click here](https://example.com)', 'markdown');

      expect(result.html).toContain('href="https://example.com"');
      expect(result.text).toContain('Click here');
    });

    it('produces plain-text fallback', async () => {
      const result = await renderEmailContent('## Summary\n\n**Bold** and *italic*', 'markdown');

      expect(result.text.toLowerCase()).toContain('summary');
      expect(result.text.toLowerCase()).toContain('bold');
    });
  });

  describe('html format', () => {
    it('sanitizes HTML and wraps in email shell', async () => {
      const result = await renderEmailContent('<p>Hello</p>', 'html');

      expect(result.html).toContain('Hello</p>');
      expect(result.html).toContain('<!DOCTYPE html>');
    });

    it('strips dangerous tags', async () => {
      const result = await renderEmailContent('<p>Safe</p><script>alert("xss")</script>', 'html');

      expect(result.html).toContain('Safe</p>');
      expect(result.html).not.toContain('<script>');
      expect(result.html).not.toContain('alert');
    });

    it('strips javascript: URLs', async () => {
      const result = await renderEmailContent('<a href="javascript:alert(1)">click</a>', 'html');

      expect(result.html).not.toContain('javascript:');
    });
  });

  describe('email shell', () => {
    it('includes brand header', async () => {
      const result = await renderEmailContent('test', 'markdown');
      expect(result.html).toContain('aflow');
    });

    it('includes footer disclaimer', async () => {
      const result = await renderEmailContent('test', 'markdown');
      expect(result.html).toContain('automated notification');
    });

    it('uses dark mode palette', async () => {
      const result = await renderEmailContent('test', 'markdown');
      expect(result.html).toContain('#0f0f0f'); // canvas
      expect(result.html).toContain('#171717'); // raised
      expect(result.html).toContain('#d7d4c3'); // text primary
    });

    it('includes hosted logo image URL', async () => {
      const result = await renderEmailContent('test', 'markdown');
      expect(result.html).toContain('res.cloudinary.com');
      expect(result.html).toContain('strawberry-robot');
    });
  });
});
