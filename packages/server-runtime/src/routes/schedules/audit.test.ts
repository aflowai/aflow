import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserId } from '@aflow/schemas';
import { buildActorContext } from '../../utils/actorContext.js';
import { recordScheduleWrite } from './registerRoutes.js';

describe('schedule write attribution for D7', () => {
  it.each([
    ['api_key', false, 'human'],
    ['api_key', true, 'service_principal'],
    ['session', false, 'human'],
  ] as const)(
    'attributes %s (service principal: %s) to %s',
    (authMethod, isServicePrincipal, kind) => {
      const record = vi.fn<FastifyInstance['audit']['record']>();
      const request = {
        authUser: {
          userId: '00000000-0000-4000-8000-000000000001' as UserId,
          roles: [],
          authMethod,
          isServicePrincipal,
        },
        method: 'PATCH',
        headers: {},
        url: '/v1/schedules/schedule',
      } as FastifyRequest;
      recordScheduleWrite({ audit: { record } } as unknown as FastifyInstance, request, {
        action: 'schedule.update',
        tenantId: '00000000-0000-4000-8000-000000000002',
        spaceId: '00000000-0000-4000-8000-000000000003',
        scheduleId: '00000000-0000-4000-8000-000000000004',
      });
      const planActor = buildActorContext(request, {
        tenantId: '00000000-0000-4000-8000-000000000002',
        tenantRole: 'admin',
      } as Parameters<typeof buildActorContext>[1]);
      expect(record.mock.calls[0]?.[0].actor.kind).toBe(planActor?.kind);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: expect.objectContaining({ kind, authMethod }),
          action: 'schedule.update',
          outcome: 'success',
        }),
      );
      expect(record.mock.calls.filter(([event]) => event.actor.kind === 'human')).toHaveLength(
        kind === 'human' ? 1 : 0,
      );
    },
  );
});
