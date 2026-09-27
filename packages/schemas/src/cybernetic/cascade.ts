import { z } from 'zod';
import {
  ActiveSurfaceLifecycleReasonCodeSchema,
  ActiveSurfaceRunLifecycleSchema,
  type ActiveSurfaceLifecycleReasonCode,
  type ActiveSurfaceRunLifecycle,
} from './activeSurface.js';

export const CascadeSystemRoleSchema = z.enum(['helmsman', 'runner', 'coach', 'other']);

export type CascadeSystemRole = z.infer<typeof CascadeSystemRoleSchema>;

/** Recursive session tree for cascade API (102i). */
export interface CascadeNode {
  sessionId: string;
  agentId: string;
  systemRole: CascadeSystemRole;
  lifecycle: ActiveSurfaceRunLifecycle;
  /** Stable reason code for analytics + tooltip translation. */
  lifecycleReasonCode?: ActiveSurfaceLifecycleReasonCode;
  /** Free-text diagnostic detail. Populated only when lifecycle === 'unknown'. */
  lifecycleReasonDetail?: string;
  startedAt: string;
  endedAt?: string | null;
  totalCostCents?: string | null;
  totalTokens: number;
  children: CascadeNode[];
}

export const CascadeNodeSchema = z.lazy(() =>
  z.object({
    sessionId: z.string().uuid(),
    agentId: z.string(),
    systemRole: CascadeSystemRoleSchema,
    lifecycle: ActiveSurfaceRunLifecycleSchema,
    lifecycleReasonCode: ActiveSurfaceLifecycleReasonCodeSchema.optional(),
    lifecycleReasonDetail: z.string().max(120).optional(),
    startedAt: z.string(),
    endedAt: z.string().nullable().optional(),
    totalTokens: z.number().int(),
    totalCostCents: z.string().nullable().optional(),
    children: z.array(CascadeNodeSchema),
  }),
) as z.ZodType<CascadeNode>;

export const CascadeDetailSchema = z.object({
  cascadeId: z.string().uuid(),
  spaceId: z.string().uuid(),
  triggerKind: z.enum(['chat_message', 'scheduled', 'on_completion', 'manual', 'unknown']),
  rootSessionId: z.string().uuid(),
  startedAt: z.string(),
  tree: CascadeNodeSchema,
});

export type CascadeDetail = z.infer<typeof CascadeDetailSchema>;

export const CascadeListItemSchema = z.object({
  cascadeId: z.string().uuid(),
  rootSessionId: z.string().uuid(),
  startedAt: z.string(),
  status: z.string(),
  agentId: z.string(),
  totalTokens: z.number().int(),
});

export type CascadeListItem = z.infer<typeof CascadeListItemSchema>;
