/**
 * Instance lifecycle — upgrade (repin to another version of the same
 * artifact), rollback (an upgrade whose target is the prior pin), and the
 * active→archived transition. All under the instance row lock, like the
 * command gateway.
 *
 * The upgrade gate is well-formed, never well-played (P3): the instance moves
 * IFF its current state validates against the target definition's
 * stateSchema. State that does not fit is refused with the validation detail
 * — the operator edits state or picks another version; the platform never
 * silently reinterprets it under a new contract.
 */
import type { AppletInstance, AppletStateVersion } from '@aflow/schemas';
import { AppletPersistenceError, AppletSchemaSafetyError } from './errors.js';
import type { AppletPersistence } from './persistence.js';
import { validateAgainstAppletSchema } from './schemaValidation.js';

export interface ApplyAppletUpgradeParams {
  persistence: AppletPersistence;
  instanceId: string;
  /** Target version — must belong to the pinned artifact's own lineage. */
  toVersionId: string;
}

export type AppletUpgradeRefusalReason =
  | 'instance_not_active'
  | 'version_not_found'
  | 'not_an_applet'
  | 'definition_invalid'
  | 'different_lineage'
  | 'unsafe_schema'
  | 'state_incompatible';

export type ApplyAppletUpgradeResult =
  | {
      status: 'upgraded';
      instance: AppletInstance;
      /** Bumped without changing state — see the snapshot rewrite below. */
      stateVersion: AppletStateVersion;
      fromVersionId: string;
    }
  | {
      /** Already pinned to the target — idempotent no-op. */
      status: 'unchanged';
      instance: AppletInstance;
      stateVersion: AppletStateVersion;
    }
  | {
      status: 'refused';
      reason: AppletUpgradeRefusalReason;
      message: string;
      /** Structural validation failures, when the refusal carries them. */
      validation?: string[];
    };

export async function applyAppletUpgrade(
  params: ApplyAppletUpgradeParams,
): Promise<ApplyAppletUpgradeResult> {
  const { persistence, instanceId, toVersionId } = params;

  return persistence.transact(async (tx) => {
    const record = await tx.loadInstanceForUpdate(instanceId);
    if (record === null) {
      throw new AppletPersistenceError(
        'instance_not_found',
        `No applet instance '${instanceId}'`,
        instanceId,
      );
    }
    const { instance } = record;
    if (instance.status !== 'active') {
      return refused(
        'instance_not_active',
        `Instance is '${instance.status}' — only active instances can be upgraded`,
      );
    }
    if (toVersionId === instance.artifactVersionId) {
      return {
        status: 'unchanged' as const,
        instance,
        stateVersion: record.stateVersion,
      };
    }

    const target = await tx.resolveAppletArtifact({
      spaceId: instance.spaceId,
      versionId: toVersionId,
    });
    switch (target.outcome) {
      case 'not_found':
        return refused('version_not_found', `No artifact version '${toVersionId}' in this space`);
      case 'not_an_applet':
        return refused(
          'not_an_applet',
          `Artifact version '${toVersionId}' carries no applet definition`,
        );
      case 'definition_invalid':
        return refused(
          'definition_invalid',
          `Definition on artifact version '${toVersionId}' does not parse: ${target.message}`,
        );
      case 'resolved':
        break;
    }

    const current = await tx.resolveAppletArtifact({
      spaceId: instance.spaceId,
      versionId: instance.artifactVersionId,
    });
    if (current.outcome !== 'resolved' || current.artifactId !== target.artifactId) {
      return refused(
        'different_lineage',
        `Version '${toVersionId}' belongs to a different artifact than the pinned '${instance.artifactVersionId}' — an instance never changes lineage`,
      );
    }

    try {
      const check = validateAgainstAppletSchema({
        schema: target.definition.stateSchema,
        cacheKey: `${target.definitionHash}#state`,
        data: record.state,
      });
      if (!check.valid) {
        return refused(
          'state_incompatible',
          'Current state does not validate against the target stateSchema — edit the state first or pick a compatible version',
          check.errors,
        );
      }
    } catch (err) {
      if (err instanceof AppletSchemaSafetyError) {
        return refused('unsafe_schema', err.message);
      }
      throw err;
    }

    const upgradedAt = new Date().toISOString();
    await tx.repinInstance(instanceId, {
      definitionHash: target.definitionHash,
      artifactVersionId: target.artifactVersionId,
      upgradedFromVersionId: instance.artifactVersionId,
      upgradedAt,
    });
    // Rewriting the unchanged state bumps its version: an in-flight
    // actor-supplied command computed under the old contract now conflicts and
    // must re-read, and the repin delta carries a version no subscriber
    // already holds, so it is never dropped as stale.
    const stateVersion = await tx.writeSnapshot(instance, record.state);

    return {
      status: 'upgraded' as const,
      instance: {
        ...instance,
        definitionHash: target.definitionHash,
        artifactVersionId: target.artifactVersionId,
        upgradedFromVersionId: instance.artifactVersionId,
        upgradedAt,
        updatedAt: upgradedAt,
      },
      stateVersion,
      fromVersionId: instance.artifactVersionId,
    };
  });
}

function refused(
  reason: AppletUpgradeRefusalReason,
  message: string,
  validation?: string[],
): ApplyAppletUpgradeResult {
  return {
    status: 'refused',
    reason,
    message,
    ...(validation !== undefined ? { validation } : {}),
  };
}

export interface ArchiveAppletInstanceParams {
  persistence: AppletPersistence;
  instanceId: string;
}

export type ArchiveAppletInstanceResult =
  | { status: 'archived'; instance: AppletInstance }
  | {
      /** Already archived — idempotent no-op, so removal flows can re-run. */
      status: 'unchanged';
      instance: AppletInstance;
    }
  | { status: 'refused'; reason: 'instance_not_active'; message: string };

/**
 * The only sanctioned transition into 'archived' — from 'active'. Archived
 * instances are read-only: the command gateway refuses actions on any
 * non-active status, and attention lists active instances only. 'ended' is a
 * terminal fact the applet's own action declared; it is not rewritten here.
 */
export async function archiveAppletInstance(
  params: ArchiveAppletInstanceParams,
): Promise<ArchiveAppletInstanceResult> {
  const { persistence, instanceId } = params;

  return persistence.transact(async (tx) => {
    const record = await tx.loadInstanceForUpdate(instanceId);
    if (record === null) {
      throw new AppletPersistenceError(
        'instance_not_found',
        `No applet instance '${instanceId}'`,
        instanceId,
      );
    }
    const { instance } = record;
    if (instance.status === 'archived') {
      return { status: 'unchanged' as const, instance };
    }
    if (instance.status !== 'active') {
      return {
        status: 'refused' as const,
        reason: 'instance_not_active' as const,
        message: `Instance is '${instance.status}' — only active instances can be archived`,
      };
    }
    await tx.touchInstance(instanceId, { status: 'archived' });
    return {
      status: 'archived' as const,
      instance: { ...instance, status: 'archived' as const, updatedAt: new Date().toISOString() },
    };
  });
}
