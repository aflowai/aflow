import { describe, it, expect } from 'vitest';

import { EntityDirectivesSchema } from '../cybernetic/directives.js';
import {
  DIRECTIVE_TEMPLATES,
  DIRECTIVE_TEMPLATES_BY_ID,
  getDirectiveTemplate,
  type DirectiveTemplateId,
} from '../cybernetic/directiveTemplates.js';

describe('DIRECTIVE_TEMPLATES (102h Phase 4)', () => {
  it('every template payload parses cleanly through EntityDirectivesSchema', () => {
    for (const template of DIRECTIVE_TEMPLATES) {
      const result = EntityDirectivesSchema.safeParse(template.directives);
      expect(result.success, `template ${template.id} failed schema validation`).toBe(true);
    }
  });

  it('every template payload is idempotent through parse() — no defaults drift on reload', () => {
    for (const template of DIRECTIVE_TEMPLATES) {
      const first = EntityDirectivesSchema.parse(template.directives);
      const second = EntityDirectivesSchema.parse(first);
      expect(second).toStrictEqual(first);
    }
  });

  it('catalog contains the canonical ids in stable order', () => {
    const ids = DIRECTIVE_TEMPLATES.map((t) => t.id);
    expect(ids).toStrictEqual<DirectiveTemplateId[]>([
      'blank',
      'knowledge-vault',
      'ml-optimization',
      'pe-intake-pricing',
      'q2o-approval',
    ]);
  });

  it('every template has non-empty operator-facing copy', () => {
    for (const template of DIRECTIVE_TEMPLATES) {
      expect(template.name.length, `${template.id} name`).toBeGreaterThan(0);
      expect(template.tagline.length, `${template.id} tagline`).toBeGreaterThan(0);
      expect(template.description.length, `${template.id} description`).toBeGreaterThan(20);
    }
  });

  it('DIRECTIVE_TEMPLATES_BY_ID round-trips against the array', () => {
    for (const template of DIRECTIVE_TEMPLATES) {
      expect(DIRECTIVE_TEMPLATES_BY_ID[template.id]).toBe(template);
    }
    expect(Object.keys(DIRECTIVE_TEMPLATES_BY_ID).sort()).toStrictEqual(
      DIRECTIVE_TEMPLATES.map((t) => t.id).sort(),
    );
  });

  describe('getDirectiveTemplate()', () => {
    it('returns the template for known ids', () => {
      expect(getDirectiveTemplate('blank')?.id).toBe('blank');
      expect(getDirectiveTemplate('ml-optimization')?.id).toBe('ml-optimization');
    });

    it('returns null for unknown ids (UI/dev-seed fallback contract)', () => {
      expect(getDirectiveTemplate('does-not-exist')).toBeNull();
      expect(getDirectiveTemplate('')).toBeNull();
    });
  });

  describe('blank template invariants', () => {
    it('only sets the required responsibility field — everything else uses schema defaults', () => {
      const blank = getDirectiveTemplate('blank')!;
      const reparsed = EntityDirectivesSchema.parse({
        version: 1,
        responsibility: blank.directives.responsibility,
      });
      expect(blank.directives).toStrictEqual(reparsed);
    });
  });
});
