/**
 * The forge vocabulary as the loop's skills speak it (Plan 340 D1). Local
 * Publish and the Local PR Shepherd build their tasks from these acts and
 * never spell a forge's endpoint, parameter, response transform or answer
 * field (D3). A provider per forge answers each act with the call its forge
 * takes (D2).
 *
 * Every argument is a template value — a `$bind`, `$text`, `$concat` or
 * `$firstOf` the task resolves when it runs — so an act is a call built
 * once, when the skill is, and filled in by the run.
 */
import type { CapabilityHint, ForgeAct, ForgeProviderId } from '@aflow/schemas';

/**
 * The acts of `FORGE_ACTS` a skill asks a forge for: all but naming the
 * provider, which `skillForgeFor` does before a forge is asked anything.
 */
export type SkillForgeAct = Exclude<ForgeAct, 'nameProvider'>;

/** A template value a task resolves when it runs. */
export type TemplateValue = unknown;

/** The `api.http.call` input an act becomes: the forge's API definition, the call and its response's shape. */
export type ForgeCall = Record<string, unknown>;

/** An `outputProjection`: which fields of the call's answer a task keeps, and under what names. */
export type ForgeProjection = Record<string, { path: string; onMissing: 'error' | 'null' }>;

/** A repository on the forge: its owner and its name. */
export interface ForgeRepository {
  owner: TemplateValue;
  repo: TemplateValue;
}

/** One change request of a repository, by its number. */
export interface ForgeChangeRequestRef extends ForgeRepository {
  number: TemplateValue;
}

/** Which handoff record is trusted: the login it was pinned as, on this change request. */
export interface ForgeHandoffTrust extends ForgeChangeRequestRef {
  author: TemplateValue;
}

/**
 * The calls each act becomes, the fields read from what the forge answers,
 * and the conditions over its answers that only the forge can word. It holds
 * a call for every {@link SkillForgeAct}, so an act added to `FORGE_ACTS`
 * fails to compile until a provider answers it. `vocabulary.test.ts` fails
 * where a call here is not an act there.
 */
export interface SkillForge extends Record<SkillForgeAct, unknown> {
  readonly provider: ForgeProviderId;

  /** What the skills declare they need of the forge's API, for the Store. */
  readonly capabilityHints: { readonly publish: CapabilityHint; readonly shepherd: CapabilityHint };

  /** The run input schemas of a repository's owner and name, by the forge's own rules. */
  readonly coordinate: {
    readonly owner: Record<string, unknown>;
    readonly repo: Record<string, unknown>;
  };

  /** Read the repository, to show the credential can see it before anything is pushed. */
  readRepository(repository: ForgeRepository): ForgeCall;
  /** `repository`: the repository's full name, as the forge answers it. */
  readonly repositoryProjection: ForgeProjection;

  /**
   * List the open change requests of a repository (D1). `loop` keeps the
   * loop's own under the folder's prefix, each in turn after the one last
   * tended. `ofBranch` asks for the branch's open one into the base, and with
   * a prefix keeps it only where it is the loop's.
   */
  listChangeRequests: {
    loop(args: ForgeRepository & { prefix: TemplateValue; lastTended: TemplateValue }): ForgeCall;
    ofBranch(
      args: ForgeRepository & {
        branch: TemplateValue;
        base: TemplateValue;
        prefix?: TemplateValue;
      },
    ): ForgeCall;
  };
  /** `prNumber` and `prUrl` of the first change request a branch listing found, null where none. */
  readonly branchListingProjection: ForgeProjection;

  /** Read a change request's state as the vocabulary's record, judged under the folder's prefix (D1). */
  readChangeRequest(args: ForgeChangeRequestRef & { prefix: TemplateValue }): ForgeCall;
  /** Read the checks on the head, judged against the base's required checks where they were read. */
  readChecks(args: ForgeRepository & { head: TemplateValue; required: TemplateValue }): ForgeCall;
  /** Read the commit the base branch points at now. */
  readBranchHead(args: ForgeRepository & { branch: TemplateValue }): ForgeCall;
  /** `statusCode` and `sha`: the branch's commit, null where it was not read. */
  readonly branchHeadProjection: ForgeProjection;
  /** Read the check names the base branch's rules require. */
  readRequiredRules(args: ForgeRepository & { branch: TemplateValue }): ForgeCall;
  /** Read the check names the base branch's protection requires, united with `rules`. */
  readRequiredChecks(
    args: ForgeRepository & { branch: TemplateValue; rules: TemplateValue },
  ): ForgeCall;
  /** Read one page of the people's reviews of a change request. */
  readReviews(args: ForgeChangeRequestRef): ForgeCall;
  /** Read the jobs of the failing check's CI run that failed. */
  readFailingJobs(args: ForgeRepository & { run: TemplateValue }): ForgeCall;
  /** Read the end of one failing job's log. */
  readJobLog(args: ForgeRepository & { job: TemplateValue }): ForgeCall;
  /** Run the failed jobs of a CI run again. */
  rerunFailedJobs(args: ForgeRepository & { run: TemplateValue }): ForgeCall;

  /** Open a change request from a branch into a base branch (D1). */
  openChangeRequest(
    args: ForgeRepository & {
      branch: TemplateValue;
      base: TemplateValue;
      title: TemplateValue;
      body: TemplateValue;
    },
  ): ForgeCall;
  /** `prNumber` and `prUrl` of the change request opened. */
  readonly openedProjection: ForgeProjection;
  /** Update a change request's title and body (D1). */
  updateChangeRequest(
    args: ForgeChangeRequestRef & { title: TemplateValue; body: TemplateValue },
  ): ForgeCall;
  /** `prNumber` of the change request updated. */
  readonly updatedProjection: ForgeProjection;

  /** Merge a change request by squash, pinned to `head` (D1). */
  mergeChangeRequest(args: ForgeChangeRequestRef & { head: TemplateValue }): ForgeCall;
  /** What a merge's answer says, worded over the output `ref` names — `tasks.merge.output`, `state.merge`. */
  readonly merge: {
    /** The forge merged the change request. */
    merged(ref: string): string;
    /** The forge did not merge it. */
    notMerged(ref: string): string;
    /** The forge refused it as it refuses a change request it will not merge as it stands. */
    refused(ref: string): string;
    /** Each holds where the refusal was other than the forge's word for a base that moved. */
    otherThanBaseMoved(ref: string): readonly string[];
    /** Where the merge's answer names the commit the merge made. */
    readonly commitPath: string;
  };
  /** Where an answer the forge refused carries the forge's words. */
  readonly refusalMessagePath: string;

  /** Read the handoff comment by its id, trusting its record only from `author` on this change request (D1). */
  readHandoff(args: ForgeHandoffTrust & { comment: TemplateValue }): ForgeCall;
  /**
   * Find the handoff on one page of the change request's conversation. Where
   * a pin kept the attempt state, `carried` hands it on, so a deleted comment
   * restarts neither the budget nor the guard.
   */
  findHandoff(
    args: ForgeHandoffTrust & {
      page: TemplateValue;
      carried: { attempts: TemplateValue; checkRun: TemplateValue };
    },
  ): ForgeCall;
  /** Post the handoff comment on a change request (D1). */
  postHandoff(args: ForgeChangeRequestRef & { body: TemplateValue }): ForgeCall;
  /** Update the handoff comment (D1). */
  updateHandoff(args: ForgeRepository & { comment: TemplateValue; body: TemplateValue }): ForgeCall;
  /** Where a handoff written names the comment's id and the login it was written as. */
  readonly handoffWritten: { readonly idPath: string; readonly authorPath: string };
}
