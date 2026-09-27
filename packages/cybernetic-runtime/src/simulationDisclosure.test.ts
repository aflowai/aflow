/**
 * Disclosure carries identity, never knowledge.
 *
 * The failure this guards against passes rather than fails: an agent handed a
 * persona's brief can answer "where is my refund?" from context, exercise no
 * tool at all, and score perfectly on a scenario it never ran. A leak here is
 * invisible in every transcript that matters.
 */
import { describe, expect, it } from 'vitest';
import {
  DisclosedCallerSchema,
  SimulationSchema,
  actingPersonaId,
  discloseCaller,
  type Simulation,
  type SimulationPersona,
} from '@aflow/schemas';
import { renderDisclosedCallers, resolveCallerForSimulation } from './simulationDisclosure.js';

const amara: SimulationPersona = {
  personaId: 'cus_77',
  label: 'Amara Osei',
  brief:
    'Three purchases: a Lumen Furniture order she returned and whose refund is in flight, a Rivet Cycles order with a missed payment, and a Halcyon Audio order paying down normally.',
};

describe('the disclosed caller', () => {
  it('carries who they are', () => {
    expect(discloseCaller(amara)).toEqual({ personaId: 'cus_77', label: 'Amara Osei' });
  });

  it('never carries the brief, which states account facts the agent must call for', () => {
    const disclosed = discloseCaller(amara);
    expect(Object.keys(disclosed)).not.toContain('brief');
    expect(JSON.stringify(disclosed)).not.toContain('Lumen Furniture');
  });

  it('withholds by default — the disclosed shape names only identity fields', () => {
    // A persona field added later is absent from disclosure until someone adds
    // it HERE, which is the review this test exists to force.
    // Identity only, and closed. An open "session context" bag stood here and
    // was removed: arbitrary JSON rendered into the agent's context is a path
    // for scenario facts — or instructions — to reach it without passing
    // through the simulated API at all.
    expect(Object.keys(DisclosedCallerSchema.shape).sort()).toEqual(['label', 'personaId']);
  });

  it('keeps the brief out of the rendered block too', () => {
    const rendered = renderDisclosedCallers([
      { integrationId: 'bnpl-core', caller: discloseCaller(amara) },
    ]);
    expect(rendered).toContain('Amara Osei');
    expect(rendered).toContain('cus_77');
    expect(rendered).not.toContain('refund is in flight');
  });
});

describe('the rendered block', () => {
  it('says nothing about the binding being simulated', () => {
    const rendered = renderDisclosedCallers([
      { integrationId: 'bnpl-core', caller: { personaId: 'cus_77', label: 'Amara Osei' } },
    ]).toLowerCase();
    // An agent that knows it is being simulated is not the agent that ships.
    for (const word of ['simulat', 'mock', 'fake', 'test', 'pretend']) {
      expect(rendered).not.toContain(word);
    }
  });

  it('tells the agent not to ask, which is the whole point of disclosing', () => {
    const rendered = renderDisclosedCallers([
      { integrationId: 'bnpl-core', caller: { personaId: 'cus_77' } },
    ]);
    expect(rendered).toContain('do not ask');
  });

  it('is empty when nothing is disclosed, so the turn carries no block at all', () => {
    expect(renderDisclosedCallers([])).toBe('');
  });
});

const bnpl: Simulation = SimulationSchema.parse({
  simulationId: 'bnpl-desk',
  revision: 1,
  name: 'Northwind Pay support desk',
  targets: { sourceKind: 'api', integrationId: 'bnpl-core' },
  personas: [amara, { personaId: 'cus_99', label: 'Tomas Berg' }],
  defaultPersonaId: 'cus_77',
  disclosePersona: true,
});

describe('who the run acts as, and whether it is told', () => {
  it('agrees with the world: the disclosed caller is the persona the rows are scoped to', () => {
    // The failure this rules out is silent — an agent told it is Amara while
    // reading Tomas's rows reports the wrong account with total confidence.
    const runInput = { personaIds: { 'bnpl-desk': 'cus_99' } };
    expect(actingPersonaId(bnpl, runInput)).toBe('cus_99');
    expect(resolveCallerForSimulation(bnpl, runInput)?.personaId).toBe('cus_99');
  });

  it('lets a run withhold what the simulation declares, which is the phone desk', () => {
    expect(
      resolveCallerForSimulation(bnpl, { disclosePersonas: { 'bnpl-desk': false } }),
    ).toBeNull();
    // Still acting as them — the agent just has to establish it.
    expect(actingPersonaId(bnpl, { disclosePersonas: { 'bnpl-desk': false } })).toBe('cus_77');
  });

  it('lets a run disclose what the simulation does not, which is the in-app assistant', () => {
    const quiet = SimulationSchema.parse({ ...bnpl, disclosePersona: false });
    expect(resolveCallerForSimulation(quiet)).toBeNull();
    expect(
      resolveCallerForSimulation(quiet, { disclosePersonas: { 'bnpl-desk': true } })?.label,
    ).toBe('Amara Osei');
  });

  it('keys the override by simulation, so another simulation is unaffected', () => {
    expect(
      resolveCallerForSimulation(bnpl, { disclosePersonas: { 'other-sim': false } })?.personaId,
    ).toBe('cus_77');
  });

  it('discloses nobody for a run acting as nobody', () => {
    // Disclosing the default here would name someone whose rows read empty.
    expect(resolveCallerForSimulation(bnpl, { personaIds: { 'bnpl-desk': null } })).toBeNull();
  });

  it('defaults to withholding, so an existing simulation makes no claim nobody made', () => {
    const undeclared = SimulationSchema.parse({
      simulationId: 'plain',
      name: 'Plain',
      targets: { sourceKind: 'api', integrationId: 'x' },
      personas: [{ personaId: 'p1' }],
      defaultPersonaId: 'p1',
    });
    expect(undeclared.disclosePersona).toBe(false);
    expect(resolveCallerForSimulation(undeclared)).toBeNull();
  });
});

describe('one resolution, structurally', () => {
  it('is reached by both readers rather than reimplemented by either', async () => {
    // The world's pin and the disclosure must name the same person. They do,
    // because neither computes it: both call `actingPersonaId`. This fails if
    // a second copy appears, which is how the two would silently disagree.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

    const readers = [
      'apps/aflow-executor-api/src/handlers/api/simulation/loadSimulation.ts',
      'packages/cybernetic-runtime/src/simulationDisclosure.ts',
    ];
    for (const reader of readers) {
      const source = await readFile(`${repoRoot}${reader}`, 'utf8');
      expect(source, `${reader} should call the shared resolver`).toContain('actingPersonaId');
      expect(
        source,
        `${reader} reimplements the default-persona fallback instead of calling actingPersonaId`,
      ).not.toMatch(/defaultPersonaId\s*\?\?/);
    }
  });
});

describe('when the disclosure is resolved', () => {
  it('is resolved before the opening turn, not read back from the session hash', async () => {
    // The first turn's input is materialized AHEAD of atomicCreateSession, and
    // that write DELs the hash — so a first turn that reads the field it is
    // about to store gets nothing, and the agent starts the conversation not
    // knowing who it is talking to. It fails silently: the block is simply
    // absent, and the agent answers with the operator's name instead.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const source = await readFile(
      `${repoRoot}apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts`,
      'utf8',
    );

    const resolvedAt = source.indexOf('resolveDisclosedCallers');
    const contextBuiltAt = source.indexOf('buildAgentFlowContextDetails');
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(contextBuiltAt).toBeGreaterThan(-1);
    expect(
      resolvedAt,
      'disclosure must be resolved before the flow context that carries it is built',
    ).toBeLessThan(contextBuiltAt);

    // And handed over rather than left to a read that cannot succeed yet.
    expect(source).toContain('disclosedCallers,');
  });
});
