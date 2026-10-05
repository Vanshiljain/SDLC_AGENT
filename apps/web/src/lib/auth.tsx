import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse, MembershipSummary, Permission, SessionResponse } from '@forgeline/shared';
import { api, applySession, refreshSession } from '@/api/client';
import { bindLiveCache } from '@/api/live';
import { qk } from '@/api/queries';
import { realtime } from './realtime';
import { session } from './session';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: Status;
  user: MeResponse['user'] | null;
  memberships: MembershipSummary[];
  organization: MembershipSummary | null;
  permissions: Set<Permission>;
  can: (p: Permission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; organizationName?: string }) => Promise<void>;
  acceptInvite: (input: { token: string; name: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchOrganization: (id: string) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useSession() {
  return useSyncExternalStore(session.subscribe, session.get);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const s = useSession();
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  const loadMe = useCallback(async () => {
    const data = await api.get<MeResponse>('/auth/me');
    qc.setQueryData(qk.me, data);
    setMe(data);
    session.set({ permissions: data.permissions, memberships: data.memberships });
    setStatus('authenticated');
  }, [qc]);

  // Restore the session from the refresh cookie on boot.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await refreshSession();
      if (cancelled) return;
      if (!ok) return setStatus('anonymous');
      try {
        await loadMe();
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  // A 401 that could not be refreshed clears the token → back to sign-in.
  useEffect(() => {
    if (status === 'authenticated' && !s.accessToken) {
      setStatus('anonymous');
      setMe(null);
      qc.clear();
    }
  }, [s.accessToken, status, qc]);

  // Realtime connection follows the token and organisation.
  useEffect(() => {
    if (status !== 'authenticated' || !s.accessToken || !s.organizationId) {
      realtime.disconnect();
      return;
    }
    realtime.connect(s.accessToken, s.organizationId);
  }, [status, s.accessToken, s.organizationId]);

  useEffect(() => bindLiveCache(qc), [qc]);

  const onSession = useCallback(
    async (res: SessionResponse) => {
      qc.clear();
      applySession(res);
      await loadMe();
    },
    [qc, loadMe],
  );

  const value = useMemo<AuthValue>(() => {
    const permissions = new Set<Permission>(me?.permissions ?? []);
    return {
      status,
      user: me?.user ?? null,
      memberships: s.memberships,
      organization: s.memberships.find((m) => m.organizationId === s.organizationId) ?? null,
      permissions,
      can: (p) => permissions.has(p),
      login: async (email, password) => onSession(await api.post<SessionResponse>('/auth/login', { email, password })),
      register: async (input) => onSession(await api.post<SessionResponse>('/auth/register', input)),
      acceptInvite: async (input) => onSession(await api.post<SessionResponse>('/auth/accept-invite', input)),
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined);
        realtime.disconnect();
        session.clear();
        qc.clear();
        setMe(null);
        setStatus('anonymous');
      },
      switchOrganization: (id) => {
        if (id === s.organizationId) return;
        session.set({ organizationId: id });
        qc.clear();
        void loadMe();
      },
    };
  }, [status, me, s.memberships, s.organizationId, onSession, qc, loadMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useRealtimeStatus(): boolean {
  return useSyncExternalStore(
    (l) => realtime.onStatus(() => l()),
    () => realtime.connected,
  );
}
