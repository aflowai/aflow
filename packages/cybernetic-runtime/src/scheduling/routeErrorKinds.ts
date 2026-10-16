/** The ways a task's routes can be refused, as `GraphValidationError` kinds. */
export type RouteValidationErrorKind =
  /** A route's condition is not a comparison on its own task's output. */
  | 'route_unsupported_when'
  /** A route enables its own task. */
  | 'route_target_self'
  /** A route enables a task that does not exist. */
  | 'route_target_unknown'
  /** A task is enabled by routes of more than one task. */
  | 'route_target_multiple_sources'
  /** A routed task also declares a `when` of its own. */
  | 'route_target_has_when'
  /** Routes to one task combine into no single-level guard. */
  | 'route_guard_inexpressible'
  /** A decision route names a question the step does not ask. */
  | 'route_decision_unknown_question'
  /** A decision route compares an answer with a value the question never gives. */
  | 'route_decision_unknown_option'
  /** A decision route's score threshold lies outside the rubric. */
  | 'route_decision_threshold_out_of_range';
