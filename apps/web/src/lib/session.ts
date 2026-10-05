import type { MembershipSummary, Permission, AuthUser } from '@forgeline/shared';

/**
 * In-memory session state. The access token never touches persistent storage;
 * the refresh token lives in an HttpOnly cookie the SPA cannot read.
 */
export interface SessionState {
  accessToken: string | null;
  expiresAt: number;
  user: AuthUser | null;
  memberships: MembershipSummary[];
  organizationId: string | null;
  permissions: Permission[];
}

type Listener = (s: SessionState) => void;

const ORG_KEY = 'fl-org';

function readOrg(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

let state: SessionState = { accessToken: null, expiresAt: 0, user: null, memberships: [], organizationId: readOrg(), permissions: [] };
const listeners = new Set<Listener>();

export const session = {
  get(): SessionState {
    return state;
  },
  set(patch: Partial<SessionState>): void {
    state = { ...state, ...patch };
    if (patch.organizationId !== undefined) {
      try {
        if (patch.organizationId) localStorage.setItem(ORG_KEY, patch.organizationId);
        else localStorage.removeItem(ORG_KEY);
      } catch {
        /* storage unavailable: keep in memory only */
      }
    }
    listeners.forEach((l) => l(state));
  },
  clear(): void {
    session.set({ accessToken: null, expiresAt: 0, user: null, memberships: [], permissions: [] });
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** Picks the stored organisation if still a member, otherwise the first real (non-demo) one. */
export function pickOrganization(memberships: MembershipSummary[], preferred: string | null): string | null {
  if (preferred && memberships.some((m) => m.organizationId === preferred)) return preferred;
  return (memberships.find((m) => !m.isDemo) ?? memberships[0])?.organizationId ?? null;
}
