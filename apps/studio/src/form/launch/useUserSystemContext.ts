import { useMemo } from 'react';
import { useAuth } from '../../lib/auth';
import type { SystemContext } from '../types';

/** The signed-in user's details for hidden fields and "fill from user" prefill. The server re-derives them. */
export function useUserSystemContext(sourceChannel: string, urlParams?: Record<string, string>): SystemContext {
  const { me } = useAuth();
  return useMemo(
    () => ({ userId: me?.user.id, userEmail: me?.user.email, userName: me?.user.name, orgId: me?.org.id, sourceChannel, urlParams }),
    [me?.user.id, me?.user.email, me?.user.name, me?.org.id, sourceChannel, urlParams],
  );
}
