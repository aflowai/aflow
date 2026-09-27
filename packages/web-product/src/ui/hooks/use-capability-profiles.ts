'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../components/providers.js';

// ============================================================================
// Types
// ============================================================================

export interface CapabilityEntry {
  capabilityGroupId: string;
  accessMode: 'read' | 'write';
}

export interface CapabilityProfile {
  id: string;
  name: string;
  description: string | null;
  allowedCapabilities: CapabilityEntry[];
  deniedCapabilities: CapabilityEntry[];
  allowedRiskModifiers: string[];
  deniedRiskModifiers: string[];
  allowPrivileged: boolean;
  isDefault: boolean;
  isSystemProfile: boolean;
  defaultForRole: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceAssignment {
  spaceId: string;
  profileId: string | null;
  profileName: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
}

export interface SpaceSummary {
  id: string;
  name: string;
  slug: string;
}

export interface CapabilityGroupInfo {
  capabilityGroupId: string;
  label: string;
  description: string;
  supportedAccessModes: string[];
}

// ============================================================================
// Hook
// ============================================================================

export function useCapabilityProfiles() {
  const { apiUrl, headers } = useApi();
  const [profiles, setProfiles] = useState<CapabilityProfile[]>([]);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [assignments, setAssignments] = useState<Map<string, SpaceAssignment>>(new Map());
  const [capabilityGroups, setCapabilityGroups] = useState<CapabilityGroupInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const [profilesRes, spacesRes, groupsRes] = await Promise.all([
        fetch(`${apiUrl}/admin/capability-profiles`, { headers: headers() }),
        fetch(`${apiUrl}/spaces`, { headers: headers() }),
        fetch(`${apiUrl}/admin/capability-groups`, { headers: headers() }),
      ]);

      if (profilesRes.ok) {
        const data = (await profilesRes.json()) as { profiles: CapabilityProfile[] };
        setProfiles(data.profiles);
      }

      let spaceList: SpaceSummary[] = [];
      if (spacesRes.ok) {
        const data = (await spacesRes.json()) as { spaces: SpaceSummary[] };
        spaceList = data.spaces;
        setSpaces(spaceList);
      }

      if (groupsRes.ok) {
        const data = (await groupsRes.json()) as { capabilityGroups: CapabilityGroupInfo[] };
        setCapabilityGroups(data.capabilityGroups);
      }

      // Fetch assignments for each space
      const assignmentMap = new Map<string, SpaceAssignment>();
      await Promise.all(
        spaceList.map(async (space) => {
          try {
            const res = await fetch(`${apiUrl}/admin/spaces/${space.id}/capability-assignment`, {
              headers: headers(),
            });
            if (res.ok) {
              const data = (await res.json()) as SpaceAssignment;
              assignmentMap.set(space.id, data);
            }
          } catch {
            // Skip failed individual fetches
          }
        }),
      );
      setAssignments(assignmentMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch capability profiles');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const createProfile = async (data: {
    name: string;
    description?: string;
    allowedCapabilities: CapabilityEntry[];
    deniedCapabilities?: CapabilityEntry[];
    allowedRiskModifiers?: string[];
    deniedRiskModifiers?: string[];
    allowPrivileged?: boolean;
    isDefault?: boolean;
    defaultForRole?: string | null;
  }): Promise<CapabilityProfile | null> => {
    try {
      const res = await fetch(`${apiUrl}/admin/capability-profiles`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message: string };
        throw new Error(err.message);
      }
      const profile = (await res.json()) as CapabilityProfile;
      await fetchAll();
      return profile;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
      return null;
    }
  };

  const updateProfile = async (
    profileId: string,
    data: Partial<{
      name: string;
      description: string | null;
      allowedCapabilities: CapabilityEntry[];
      deniedCapabilities: CapabilityEntry[];
      allowedRiskModifiers: string[];
      deniedRiskModifiers: string[];
      allowPrivileged: boolean;
      isDefault: boolean;
      defaultForRole: string | null;
    }>,
  ): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/admin/capability-profiles/${profileId}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message: string };
        throw new Error(err.message);
      }
      await fetchAll();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
      return false;
    }
  };

  const deleteProfile = async (profileId: string): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/admin/capability-profiles/${profileId}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message: string };
        throw new Error(err.message);
      }
      await fetchAll();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
      return false;
    }
  };

  const assignProfile = async (spaceId: string, profileId: string): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/admin/spaces/${spaceId}/capability-assignment`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ profileId }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message: string };
        throw new Error(err.message);
      }
      await fetchAll();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign profile');
      return false;
    }
  };

  const unassignProfile = async (spaceId: string): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/admin/spaces/${spaceId}/capability-assignment`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message: string };
        throw new Error(err.message);
      }
      await fetchAll();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unassign profile');
      return false;
    }
  };

  return {
    profiles,
    spaces,
    assignments,
    capabilityGroups,
    isLoading,
    error,
    refresh: fetchAll,
    createProfile,
    updateProfile,
    deleteProfile,
    assignProfile,
    unassignProfile,
  };
}
