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
import {
  HOST_FOLDER_CONNECT_COMMAND,
  SpaceTemplateSchema,
  type SpaceTemplate,
  type SpaceTemplateInput,
} from '@aflow/schemas';

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

/**
 * Plan 330 D3: coding on the operator's own GitHub repository. The single
 * Coding Loop entry — the four loop skills, the shepherd agent and the github
 * api_definition — the directives that keep each stream of work on a plan node
 * and drive it through the loop, and the help that explains the protocol. The
 * readiness list walks the operator to their own repository (D4); the
 * folder's preview is not on it until Plan 320 P6(a) builds the declaration
 * it reads (§7 F3).
 */
const CODING_WITH_GITHUB: SpaceTemplateInput = {
  templateId: 'coding-with-github',
  version: 1,
  spaceName: 'Coding',
  bundleIds: ['coding-loop'],
  directives: {
    responsibility:
      "Drive changes to the repository in the space's connected folder through the coding loop: commission the coding agent installed on the machine, review what it made, publish it as a pull request through the space's github binding, and let the Local PR Shepherd tend that pull request until it merges or a person takes it over. Keep every stream of work on a node of the space's plan, so the plans board shows what is in flight, what waits on the operator and what is done.",
    priorities: [
      "One conversation per stream of work. Start a stream from its plan node: read the node first, brief the commission from its goal and criteria and what the operator adds, start the commission and its publication with the node's planNodeId, and record where the node stands when the round ends. Never post into another stream's conversation or cancel its runs.",
      'Commission, review, publish. Start Commission Change without waiting, briefed with each finding: its file, its line where known, what is wrong, what right looks like, and the tests to add. Publish its patchRef with Publish Local Changes, which reviews the commit, and follow its decision: fix_before_merge is a fix round on the same branch from the fixRound it names, publish_as_is pushes.',
      "Merging follows the folder's merge posture. Under never the operator merges; under when-green the Local PR Shepherd merges a green pull request whose head the review approved, on the operator's approval. A pull request labelled hands-off is left alone, and nothing is pushed to an open pull request outside the loop without the operator's word.",
      "Resolve the space's connected folder and the space's github binding when a run starts, and name no folder, repository, credential or port of your own. Where setup is missing — no paired machine, no folder that pushes, no github credential, no coding agent chosen, no shepherd schedule — say which, and point to where it is set up rather than working around it.",
      'Record what a round taught that the next one should start knowing on its plan node, citing the runs it came from, and mark a node done only with the outcome that met its criteria.',
    ],
    style:
      'Report a round in a few lines: the node, what ran, the verdict, and what the operator is asked to do next.',
  },
  help: ['driving-work-through-the-loop', 'coding-agent-on-this-computer'],
  readiness: [
    {
      key: 'pair-machine',
      title: 'Pair this machine',
      required: true,
      answeredBy: 'pair_machine',
      reading: 'machine',
      page: '/computer',
    },
    {
      key: 'connect-folder',
      title: "Connect the repository's folder with a branch prefix and a merge posture",
      required: true,
      answeredBy: 'pair_machine',
      reading: 'folder',
      page: '/computer',
      command: HOST_FOLDER_CONNECT_COMMAND,
    },
    {
      key: 'github-credential',
      title: 'Bind a GitHub credential with the scopes publish and the shepherd need',
      required: true,
      answeredBy: 'github_credential',
      page: '/integrations',
    },
    {
      key: 'coding-harness',
      title: 'Choose the coding agent',
      required: true,
      answeredBy: 'coding_harness',
      page: '/computer',
    },
    {
      key: 'shepherd-schedule',
      title: 'Arm the shepherd schedule',
      required: true,
      answeredBy: 'shepherd_schedule',
      page: '/triggers',
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
  {
    template: CODING_WITH_GITHUB,
    name: 'Coding with GitHub',
    tagline:
      'A new space that commissions, reviews, publishes and shepherds changes on your own GitHub repository.',
    description: `Creates a new space and installs **Coding Loop** in it, with the Helmsman directives that drive work through the loop and keep each stream of work on the space's plan.

**What you get**:
- A new space beside the ones you have. Nothing in your other spaces changes.
- **Coding Loop**, installed the way the Store installs it anywhere else: Commission Change, Review Local Changes, Publish Local Changes, the Local PR Shepherd skill and agent, and the GitHub connector's definition.
- The directives for driving the loop: one conversation per stream of work, each stream on a node of the space's plan, commission, review and publish, and merges by the folder's merge posture.
- The help article on driving work through the loop.

**Setting it up**: the space lists what it still needs, each item with its state and where it changes — pair this machine, connect the repository's folder with a branch prefix and a merge posture, bind a GitHub credential, choose the coding agent, and arm the shepherd schedule. Nothing is scheduled until you arm it.`,
    tags: ['quick-start', 'coding', 'github', 'local'],
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
