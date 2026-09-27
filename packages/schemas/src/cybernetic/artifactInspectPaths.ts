const RUN_PATH_PATTERN =
  /^(?:run\/header|run\/tasks|run\/tasks\/[A-Za-z0-9._-]+\/(?:meta|reflection|input|output)|run\/eval)$/;

const TASK_PATH_PATTERN = /^task\/(?:meta|reflection|input|output)$/;

const SESSION_PATH_PATTERN = /^(?:session\/meta|session\/steps|session\/steps\/[A-Za-z0-9._-]+)$/;

/**
 * Local alias of the target-kind union so this module stays decoupled
 * from `operations/artifactInspect.ts`. The two are kept in lockstep
 * because both file imports re-export from the schemas package; the
 * canonical type lives in `operations/artifactInspect.ts` as
 * `ArtifactInspectTargetKind`.
 */
type InspectTargetKind = 'session' | 'run' | 'task';

/**
 * Return true iff `path` is in the stable vocabulary for the given
 * `targetKind`. Used by the read handler to reject ad-hoc paths and
 * by tests to pin the path-shape contract.
 */
export function isStableInspectPath(kind: InspectTargetKind, path: string): boolean {
  switch (kind) {
    case 'run':
      return RUN_PATH_PATTERN.test(path);
    case 'task':
      return TASK_PATH_PATTERN.test(path);
    case 'session':
      return SESSION_PATH_PATTERN.test(path);
  }
}
