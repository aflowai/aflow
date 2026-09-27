/**
 * Compute the canonical tag set for a bundle-published artifact.
 *
 * @param bundleId — bundle that owns the seed
 * @param bindingId — short, bundle-scoped binding handle (e.g. `portfolio-review-card`)
 * @param skillSlugs — every skill in the bundle that declares this binding
 *                     via `SkillManifest.uiOutput.bindingId`. Empty when no
 *                     skill references the binding (e.g. operator-facing
 *                     artifact shipped for ad-hoc render).
 * @param extras — additional bundle-author-supplied tags (`BundleArtifactSeed.tags`)
 */
export function artifactTagsForBundleSkill(args: {
  bundleId: string;
  bindingId: string;
  skillSlugs?: readonly string[];
  extras?: readonly string[];
}): string[] {
  const { bundleId, bindingId, skillSlugs = [], extras = [] } = args;

  const tags = new Set<string>();
  tags.add(`bundle:${bundleId}`);
  tags.add(`binding:${bindingId}`);
  for (const slug of skillSlugs) {
    tags.add(`skill:${slug}`);
  }
  for (const tag of extras) {
    tags.add(tag);
  }
  return [...tags];
}
