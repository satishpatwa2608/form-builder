import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, onSessionEnded, refreshSession, setAccessToken } from './api';
import type { Me, Permission } from './types';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  me: Me | null;
  /** Throws ApiError; code TWO_FACTOR_REQUIRED means ask for a code and call again with it. */
  signIn: (email: string, password: string, code?: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  reload: () => Promise<void>;
  can: (permission: Permission) => boolean;
  /** The org requires two-factor and this session hasn't got it: only account security is usable. */
  needsTwoFactor: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);

  const loadMe = useCallback(async () => {
    const next = await api<Me>('/auth/me');
    setMe(next);
    setStatus('signedIn');
  }, []);

  const endSession = useCallback(() => {
    setAccessToken(null);
    setMe(null);
    setStatus('signedOut');
    queryClient.clear();
  }, [queryClient]);

  // On load: the refresh cookie (if any) gives a new access token.
  useEffect(() => {
    onSessionEnded(endSession);
    void (async () => {
      if (await refreshSession()) {
        try {
          await loadMe();
          return;
        } catch {
          /* fall through */
        }
      }
      setStatus('signedOut');
    })();
  }, [endSession, loadMe]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      signIn: async (email, password, code) => {
        const res = await api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password, ...(code ? { code } : {}) } });
        setAccessToken(res.accessToken);
        await loadMe();
      },
      signOut: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        endSession();
      },
      switchOrg: async (orgId) => {
        const res = await api<{ accessToken: string }>('/auth/switch-org', { method: 'POST', body: { orgId } });
        setAccessToken(res.accessToken);
        queryClient.clear();
        await loadMe();
      },
      reload: loadMe,
      can: (permission) => !!me?.org.permissions.includes(permission),
      needsTwoFactor: !!me && me.org.require2fa && !me.session.mfa,
    }),
    [status, me, loadMe, endSession, queryClient],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth needs <AuthProvider>');
  return ctx;
}

export const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (!code || e.code === code);
