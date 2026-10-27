/**
 * Space templates — the payloads of the Store's `space` listings (Plan 330 D2).
 * They are code beside the bundle catalog, listed by the Store catalog and
 * hashed in `storeCatalogHashes.json` like every other entry, so there is
 * nothing to seed: every install's Store lists them.
 *
 * Nothing in a template names this machine, this repository or this operator
 * (D6). Folders, credentials, harnesses and ports are the operator's to
 * declare; a template only asks for them. `spaceTemplates.guard.test.ts` reads
 * every template's content and fails on any of them.
 */
import { SpaceTemplateSchema, type SpaceTemplate, type SpaceTemplateInput } from '@aflow/schemas';

/**
 * The template Plan 330 P1 proves the `space` kind on: one bundle — Local
 * Code Review, the smallest in the bundle catalog that ships to production —
 * and one directive. It asks for a paired machine and a connected folder, the
 * one thing that bundle cannot run without.
 */
const LOCAL_REVIEW_QUICK_START: SpaceTemplateInput = {
  templateId: 'local-review-quick-start',
  version: 1,
  spaceName: 'Code Review',
  bundleIds: ['local-code-review'],
  directives: {
    responsibility:
      "Review committed changes in the space's connected folder with the coding agent installed on this computer, and report what the operator should fix before the change merges.",
    priorities: [
      'Name the file, the line and the evidence for every finding, and leave each fix as separate work rather than applying it.',
    ],
  },
  help: ['coding-agent-on-this-computer'],
  readiness: [
    {
      key: 'pair-machine',
      title: 'Pair this computer and connect the folder to review',
      required: true,
      answeredBy: 'pair_machine',
      page: '/computer',
    },
  ],
};

export interface SpaceTemplateListing {
  template: SpaceTemplate;
  name: string;
  tagline: string;
  description: string;
  tags: string[];
}

const RAW_TEMPLATES: ReadonlyArray<
  Omit<SpaceTemplateListing, 'template'> & {
    template: SpaceTemplateInput;
  }
> = [
  {
    template: LOCAL_REVIEW_QUICK_START,
    name: 'Code Review on This Computer',
    tagline: 'A new space that reviews committed changes with the coding agent on this computer.',
    description: `Creates a new space and installs **Local Code Review** in it, with a directive that keeps every review to findings that name their file, line and evidence.

**What you get**:
- A new space named after the work, beside the ones you have. Nothing in your other spaces changes.
- The **Local Code Review** skill, installed the way the Store installs it anywhere else, so it shows as installed and updates from its own listing.
- The space's directive for reviewing: findings with evidence, and fixes left as separate work.

**After it is made**: pair this computer and connect the repository's folder under **This Computer**, then ask for a review of a range — \`main..HEAD\`, the last few commits, a single commit.`,
    tags: ['quick-start', 'coding', 'review', 'local'],
  },
];

/** Every space template, parsed through `SpaceTemplateSchema` at module load. */
export const SPACE_TEMPLATE_CATALOG: readonly SpaceTemplateListing[] = RAW_TEMPLATES.map((raw) => {
  const result = SpaceTemplateSchema.safeParse(raw.template);
  if (!result.success) {
    throw new Error(
      `Invalid space template "${raw.template.templateId}": ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return { ...raw, template: result.data };
});

export function getSpaceTemplate(templateId: string): SpaceTemplate | null {
  return (
    SPACE_TEMPLATE_CATALOG.find((listing) => listing.template.templateId === templateId)
      ?.template ?? null
  );
}
