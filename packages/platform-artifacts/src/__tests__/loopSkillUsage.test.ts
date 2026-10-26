import { describe, expect, it } from 'vitest';
import { ComposedWorkflowSchema, SkillUsageSchema } from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';

const LOOP = [
  ['commission-change', 'local-commission'],
  ['review-local-changes', 'local-code-review'],
  ['publish-local-changes', 'local-publish'],
  ['local-pr-shepherd', 'local-shepherd'],
] as const;

const usageOf = (catalogId: string) => getSkillCatalogEntry(catalogId)?.bundle.workflow.usage;

describe('the loop skills carry their usage in the Store bundle', () => {
  it.each(LOOP)('%s says when to use it, when not, and its pitfalls', (catalogId) => {
    const usage = usageOf(catalogId);
    expect(SkillUsageSchema.safeParse(usage).success).toBe(true);
    expect(usage?.whenToUse.length).toBeGreaterThan(0);
    expect(usage?.whenNotToUse.length).toBeGreaterThan(0);
    expect(usage?.pitfalls.length).toBeGreaterThan(0);
    expect(usage?.next.length).toBeGreaterThan(0);
  });

  it.each(LOOP)('%s keeps its usage through the shape a bundle installs', (catalogId) => {
    const workflow = getSkillCatalogEntry(catalogId)?.bundle.workflow;
    expect(ComposedWorkflowSchema.parse(workflow).usage).toEqual(workflow?.usage);
  });

  it.each(LOOP)('the %s bundle has no install-time hint left as the only copy', (_, bundleId) => {
    expect(getSkillBundleEntry(bundleId)?.helmsmanHints).toEqual([]);
  });

  it('names each successor: commission, then publish, then the shepherd', () => {
    expect(usageOf('commission-change')?.next[0]?.skill).toBe('publish-local-changes');
    expect(usageOf('publish-local-changes')?.next[0]?.skill).toBe('local-pr-shepherd');
    expect(usageOf('local-pr-shepherd')?.next[0]?.operation).toBe('agent.schedule.create');
  });

  it('places review inside publish, which runs it itself', () => {
    const review = usageOf('review-local-changes');
    expect(review?.whenNotToUse.join('\n')).toContain('Publish Local Changes reviews');
    expect(review?.next.map((n) => n.skill)).toContain('publish-local-changes');
    expect(usageOf('publish-local-changes')?.whenNotToUse.join('\n')).toContain(
      'the publication reviews everything its push would add itself',
    );
  });

  it('names only skills the catalog has as what follows', () => {
    for (const [catalogId] of LOOP) {
      for (const next of usageOf(catalogId)?.next ?? []) {
        if (next.skill) expect(getSkillCatalogEntry(next.skill), next.skill).not.toBeNull();
      }
    }
  });

  it('says a bug fix in the repository is Commission Change', () => {
    const first = usageOf('commission-change')?.whenToUse[0] ?? '';
    for (const word of ['fix', 'bug', 'repo']) expect(first.toLowerCase()).toContain(word);
  });
});
