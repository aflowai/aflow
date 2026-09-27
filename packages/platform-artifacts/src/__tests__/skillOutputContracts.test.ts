/**
 * A skill's output contract has to be satisfiable by some object.
 *
 * A closed schema (`additionalProperties: false`) that requires a key it never
 * defines admits nothing at all, and the task fails output validation on every
 * run — after doing its work and spending whatever it spent. Nothing else
 * checks it: the schema is valid JSON Schema, so the fixture parses, the build
 * passes, and the contradiction only surfaces when a real run is refused.
 */
import { describe, expect, it } from 'vitest';
import { SKILL_CATALOG } from '../skillCatalog.js';

interface SchemaNode {
  type?: unknown;
  required?: unknown;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  items?: unknown;
}

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null;
}

/** Every closed object in the schema, addressed by its path for a readable failure. */
function closedObjects(schema: unknown, path: string): Array<{ path: string; node: SchemaNode }> {
  if (!isNode(schema)) return [];
  const found: Array<{ path: string; node: SchemaNode }> = [];
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    found.push({ path, node: schema });
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    found.push(...closedObjects(child, `${path}/${key}`));
  }
  if (schema.items !== undefined) found.push(...closedObjects(schema.items, `${path}[]`));
  return found;
}

describe('every skill output contract admits at least one object', () => {
  const tasks = SKILL_CATALOG.flatMap((skill) =>
    (skill.bundle.workflow.tasks ?? []).map((task) => ({ skill: skill.catalogId, task })),
  );

  it('requires no key the schema leaves undefined', () => {
    const contradictions: string[] = [];
    for (const { skill, task } of tasks) {
      const schema = task.outputContract?.schema;
      if (schema === undefined) continue;
      for (const { path, node } of closedObjects(schema, `${skill}/${task.taskId}`)) {
        const defined = new Set(Object.keys(node.properties ?? {}));
        for (const key of node.required as unknown[]) {
          if (typeof key === 'string' && !defined.has(key)) {
            contradictions.push(`${path}: requires '${key}', which it does not define`);
          }
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  /**
   * Only agent producers. An operation task's real output shape is the
   * operation's, and its `outputContract` is augmented from that rather than
   * declaring it (`deriveOpBoundProducerShapes`) — so a key absent there says
   * nothing. On an agent task the contract is what the agent is forced to
   * return, and a binding reading past it reads nothing.
   */
  /**
   * Two bindings that read a key their producer does not declare. Both predate
   * this guard and both are real — the consuming task receives nothing under
   * that name — but fixing them changes two unrelated skills' contracts and
   * their bundle versions, so they are named here rather than silently passed.
   */
  const KNOWN_UNDECLARED = new Set([
    "daily-trading-cycle/record-learnings.learnings reads 'learnings' from 'record', which declares no such output",
    "kaggle-competition-optimizer/record-learnings.learnings reads 'learnings' from 'extract-learnings', which declares no such output",
  ]);

  it('binds every downstream input to an output its agent producer declares', () => {
    const missing: string[] = [];
    for (const skill of SKILL_CATALOG) {
      const byId = new Map(skill.bundle.workflow.tasks.map((task) => [task.taskId, task]));
      for (const task of skill.bundle.workflow.tasks) {
        for (const [name, binding] of Object.entries(task.inputBindings ?? {})) {
          if (binding.kind !== 'task_output') continue;
          const producer = byId.get(binding.taskId);
          if (producer?.type !== 'agent') continue;
          const schema = producer.outputContract?.schema as SchemaNode | undefined;
          if (schema?.properties === undefined) continue;
          const head = binding.path.split('.')[0] ?? binding.path;
          if (!(head in schema.properties)) {
            missing.push(
              `${skill.catalogId}/${task.taskId}.${name} reads '${binding.path}' from ` +
                `'${binding.taskId}', which declares no such output`,
            );
          }
        }
      }
    }
    expect(missing.filter((entry) => !KNOWN_UNDECLARED.has(entry))).toEqual([]);
    // A named exception that has been fixed should stop being named.
    expect(missing.filter((entry) => KNOWN_UNDECLARED.has(entry)).sort()).toEqual(
      [...KNOWN_UNDECLARED].sort(),
    );
  });
});
