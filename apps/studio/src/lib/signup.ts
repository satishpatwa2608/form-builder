import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Whether new accounts can be made on this installation. Asked before anyone is signed in.
 * While it is not known (or the server cannot say) the pages behave as if it were open:
 * the server refuses a sign-up that is not allowed, whatever the page shows.
 */
export function useSignupOpen(): boolean {
  const { data } = useQuery({ queryKey: ['auth-config'], queryFn: () => api<{ signup: 'open' | 'closed' }>('/auth/config'), staleTime: 5 * 60_000, retry: false });
  return data?.signup !== 'closed';
}
