import { useQuery } from '@tanstack/react-query';
import { auth, l27, l27All } from './api';
import type { Team } from './types';

// Whether the server lets writes through (L27_ALLOW_WRITES). Edit buttons hide when it doesn't.
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: auth.me, retry: false });
}

export function useCanWrite() {
  return !!useMe().data?.allowWrites;
}

export interface Location {
  id: number;
  name: string;
  active: boolean;
  default: boolean;
}

export function useLocations() {
  return useQuery({
    queryKey: ['locations'],
    queryFn: () => l27All<Location>('/v1/staff/locations'),
    staleTime: 10 * 60_000,
    select: (list) => list.filter((l) => l.active),
  });
}

export function useActiveTeams() {
  return useQuery({
    queryKey: ['teams', 'active-all'],
    queryFn: () => l27All<Team>('/v1/staff/teams', { filter: 'active' }),
    staleTime: 10 * 60_000,
  });
}

export { l27 };
