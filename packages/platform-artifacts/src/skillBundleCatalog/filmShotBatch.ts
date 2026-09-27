import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';

/**
 * The bundle ships the two skills and nothing else. There is no connector to
 * wire: a render reaches its provider through the platform's own media
 * operations and the credential the space already holds for them, so a binding
 * here would be a second way to reach the same route.
 */
export const FILM_SHOT_BATCH: SkillBundleInput = {
  bundleId: 'film-production' as SkillBundleId,
  version: 6,
  name: 'Film Production',
  tagline:
    'From an idea to a film — author the world from the operator’s brief, then render the shots that owe work.',
  description: `Installs the three skills that carry a film from an idea to a watchable sequence, in the order the work happens:

**Stage the Film Concept** — the operator's idea becomes a film the room can read before anything is spent: the story, the cast and places described in words (the casting sheet), the scenes, and the shots in story order. Nothing is rendered; the pitch is approved or redirected in the room with ordinary sentences.

**Develop the Film World** — the operator says what the film is, who is in it, where it happens and what it should feel like, in their own words. The pass renders the plates the world needs — the grade first (palette and light, no scene), then the places, then the people — binds the cast into the film's library, and authors the scenes and shots that will be rendered from them. What the brief leaves open it decides with taste and reports as decisions, each reversible with a sentence; it asks nothing mid-run and renders no clips.

**Render Film Shots** — point it at a film and it produces the shots that do not yet carry a usable take.

**A shot that animates a frame costs two renders, not one.** The still comes first, made from the film's plates — its characters, its location, and the graded plate the whole film is authored against — and the clip is animated from that still. Budget a pass as two renders per shot, not one.

**What the render pass does**:
- Reads the film's own document: every shot's prompt, route, length, what it conditions on, the recipe for its first frame, and the entities bound into its roles.
- Renders the still a shot owes: one it has never had, one whose recipe, bindings or direction of travel have moved since, or one authored against a grade the film has since changed. Records it back onto the shot with what that render read.
- Renders only the clips that **owe** a take — one with no take, or one whose take was rendered before the shot was edited. A shot whose take still matches is left alone, because every render is paid for and re-rolling finished work is the cost this pass exists to avoid.
- Records each take back onto its shot with the recipe it was actually rendered from, which is what makes the film's own drift reading true afterwards.
- Reports what the pass produced and spent, including **shots that bought a still and no clip** — those are neither finished nor untouched, and reading them as untouched buys the still twice.
- For any shot it could not render, carries the refusal in that shot's own words, naming what to edit.

**After install**:
1. Install the **Film** applet from the Store — the film these skills work on is a Film applet instance, and this bundle does not carry it.
2. Make sure the space has a credential for an image- and video-capable provider (**Settings → Credentials**).
3. Say what the film is — "I have an idea for a film about…" — and the concept is staged from your words: story, cast, places, shots, nothing rendered. Approve it, or redirect any part with a sentence.
4. Then "develop the world" renders the plates from the approved cast, and "render the shots" produces the film. One run per film per pass.`,
  tags: ['film', 'video', 'batch', 'generation', 'applet', 'pre-production'],
  skillCatalogIds: ['film-concept', 'film-world-development', 'film-shot-batch'],
  prerequisiteBundleIds: [],
  apiDefinitions: [],
  apiBindingTemplates: [],
};
