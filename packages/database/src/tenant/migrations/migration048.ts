/**
 * Tenant migration 48 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration048(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const jsonReplacePairs: Array<[string, string]> = [
    ['cybernetic-executive', 'cybernetic-helmsman'],
    ['cybernetic-worker', 'cybernetic-runner'],
    ['cybernetic-learner', 'cybernetic-coach'],
    ['worker_model', 'runner_model'],
    ['worker_system_prompt', 'runner_system_prompt'],
    ['worker_tools', 'runner_tools'],
    ['cybernetic_worker_id', 'cybernetic_runner_id'],
    ['cybernetic_learner_id', 'cybernetic_coach_id'],
    ['run-learner', 'run-coach'],
  ];
  let defJsonExpr = 'definition_json::text';
  for (const [from, to] of jsonReplacePairs) {
    defJsonExpr = `replace(${defJsonExpr}, '${from}', '${to}')`;
  }

  await sqlClient.unsafe(`
      UPDATE "${schemaName}".sessions
        SET agent_id = CASE agent_id
          WHEN 'cybernetic-executive' THEN 'cybernetic-helmsman'
          WHEN 'cybernetic-worker' THEN 'cybernetic-runner'
          WHEN 'cybernetic-learner' THEN 'cybernetic-coach'
          ELSE agent_id
        END
        WHERE agent_id IN ('cybernetic-executive', 'cybernetic-worker', 'cybernetic-learner');
  
      UPDATE "${schemaName}".spaces
        SET default_agent_id = CASE default_agent_id
          WHEN 'cybernetic-executive' THEN 'cybernetic-helmsman'
          WHEN 'cybernetic-worker' THEN 'cybernetic-runner'
          WHEN 'cybernetic-learner' THEN 'cybernetic-coach'
          ELSE default_agent_id
        END
        WHERE default_agent_id IN ('cybernetic-executive', 'cybernetic-worker', 'cybernetic-learner');
  
      UPDATE "${schemaName}".agent_definitions
        SET
          agent_id = CASE agent_id
            WHEN 'cybernetic-executive' THEN 'cybernetic-helmsman'
            WHEN 'cybernetic-worker' THEN 'cybernetic-runner'
            WHEN 'cybernetic-learner' THEN 'cybernetic-coach'
            ELSE agent_id
          END,
          definition_json = (${defJsonExpr})::jsonb
        WHERE agent_id IN ('cybernetic-executive', 'cybernetic-worker', 'cybernetic-learner');
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.space.bootstrapped'
        WHERE event_type = 'entity.bootstrapped';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.space.graduated'
        WHERE event_type = 'entity.graduated';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.directives.updated'
        WHERE event_type = 'entity.directives_updated';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.directives.staged'
        WHERE event_type = 'entity.directives_staged';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.runner.dispatched'
        WHERE event_type = 'entity.worker.dispatched';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.runner.completed'
        WHERE event_type = 'entity.worker.completed';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.coach.suppressed'
        WHERE event_type = 'entity.learner.duplicateSuppressed';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.skill.authored'
        WHERE event_type = 'entity.skill.create.attempt';
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.training.entered'
        WHERE event_type = 'entity.training_mode_changed'
          AND COALESCE((payload->>'inTraining')::boolean, true) = true;
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = 'entity.training.exited'
        WHERE event_type = 'entity.training_mode_changed'
          AND COALESCE((payload->>'inTraining')::boolean, true) = false;
  
      UPDATE "${schemaName}".entity_event_log
        SET event_type = replace(event_type, 'entity.learner.', 'entity.coach.')
        WHERE event_type LIKE 'entity.learner.%';
  
      UPDATE "${schemaName}".entity_event_log
        SET payload = jsonb_set(
          payload,
          '{resolvedAgents}',
          jsonb_strip_nulls(jsonb_build_object(
            'helmsman', COALESCE(payload#>'{resolvedAgents,helmsman}', payload#>'{resolvedAgents,executive}'),
            'runner', COALESCE(payload#>'{resolvedAgents,runner}', payload#>'{resolvedAgents,worker}'),
            'coach', COALESCE(payload#>'{resolvedAgents,coach}', payload#>'{resolvedAgents,learner}')
          ))
        )
        WHERE payload ? 'resolvedAgents'
          AND (
            payload->'resolvedAgents' ? 'executive'
            OR payload->'resolvedAgents' ? 'worker'
            OR payload->'resolvedAgents' ? 'learner'
          );
  
      UPDATE "${schemaName}".entity_event_log
        SET workflow_slug = CASE workflow_slug
          WHEN 'learner-review-artifacts' THEN 'coach-review-artifacts'
          WHEN 'learner-consolidate-interaction' THEN 'coach-consolidate-interaction'
          WHEN 'learner-scarcity-sweep' THEN 'coach-scarcity-sweep'
          WHEN 'learner-eval-review' THEN 'coach-eval-review'
          ELSE workflow_slug
        END
        WHERE workflow_slug IN (
          'learner-review-artifacts',
          'learner-consolidate-interaction',
          'learner-scarcity-sweep',
          'learner-eval-review'
        );
  
      UPDATE "${schemaName}".memory_docs
        SET path = replace(replace(replace(replace(path,
          'learner-review-artifacts', 'coach-review-artifacts'),
          'learner-consolidate-interaction', 'coach-consolidate-interaction'),
          'learner-scarcity-sweep', 'coach-scarcity-sweep'),
          'learner-eval-review', 'coach-eval-review')
        WHERE deleted_at IS NULL
          AND path IS NOT NULL
          AND (
            path LIKE '%learner-review-artifacts%'
            OR path LIKE '%learner-consolidate-interaction%'
            OR path LIKE '%learner-scarcity-sweep%'
            OR path LIKE '%learner-eval-review%'
          );
  
      UPDATE "${schemaName}".memory_docs
        SET inline_content = replace(replace(replace(replace(inline_content,
          'learner-review-artifacts', 'coach-review-artifacts'),
          'learner-consolidate-interaction', 'coach-consolidate-interaction'),
          'learner-scarcity-sweep', 'coach-scarcity-sweep'),
          'learner-eval-review', 'coach-eval-review')
        WHERE deleted_at IS NULL
          AND inline_content IS NOT NULL
          AND (
            inline_content LIKE '%learner-review-artifacts%'
            OR inline_content LIKE '%learner-consolidate-interaction%'
            OR inline_content LIKE '%learner-scarcity-sweep%'
            OR inline_content LIKE '%learner-eval-review%'
          );
  
      UPDATE "${schemaName}".memory_doc_versions
        SET inline_content = replace(replace(replace(replace(inline_content,
          'learner-review-artifacts', 'coach-review-artifacts'),
          'learner-consolidate-interaction', 'coach-consolidate-interaction'),
          'learner-scarcity-sweep', 'coach-scarcity-sweep'),
          'learner-eval-review', 'coach-eval-review')
        WHERE inline_content IS NOT NULL
          AND (
            inline_content LIKE '%learner-review-artifacts%'
            OR inline_content LIKE '%learner-consolidate-interaction%'
            OR inline_content LIKE '%learner-scarcity-sweep%'
            OR inline_content LIKE '%learner-eval-review%'
          );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (48, 'Plan 104a — unified naming migration (agents, events, payloads)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
