import { describe, expect, it } from 'vitest';
import {
  CapabilityProfileSchema,
  CreateCapabilityProfileSchema,
  UpdateCapabilityProfileSchema,
} from './capabilityProfile.js';
import { CapabilitySnapshotSchema } from './runAccessGrant.js';

describe('CreateCapabilityProfileSchema', () => {
  it('parses allowed and denied capabilities', () => {
    const parsed = CreateCapabilityProfileSchema.parse({
      name: 'Standard',
      allowedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'read' }],
    });
    expect(parsed.allowedCapabilities).toHaveLength(1);
    expect(parsed.deniedCapabilities).toEqual([]);
  });
});

describe('UpdateCapabilityProfileSchema', () => {
  it('allows empty update body (all fields optional)', () => {
    const parsed = UpdateCapabilityProfileSchema.parse({});
    expect(parsed).toEqual({});
  });
});

describe('CapabilityProfileSchema (read shape)', () => {
  const baseProfile = {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Standard',
    description: null,
    allowedCapabilities: [{ capabilityGroupId: 'ai.text', accessMode: 'read' as const }],
    deniedCapabilities: [],
    allowedRiskModifiers: [],
    deniedRiskModifiers: [],
    allowPrivileged: false,
    isDefault: true,
    isSystemProfile: false,
    defaultForRole: 'editor',
    createdAt: '2026-05-21T10:00:00.000Z',
    updatedAt: '2026-05-21T10:00:00.000Z',
  };

  it('parses a full profile without gated capabilities', () => {
    const parsed = CapabilityProfileSchema.parse(baseProfile);
    expect(parsed.allowedCapabilities).toHaveLength(1);
  });
});

describe('CapabilitySnapshotSchema (runtime grant)', () => {
  it('parses capability snapshot without gated capabilities', () => {
    const snapshot = CapabilitySnapshotSchema.parse({
      allowedCapabilities: [],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    });
    expect(snapshot.allowedCapabilities).toEqual([]);
  });
});
