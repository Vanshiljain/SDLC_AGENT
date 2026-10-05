import { useEffect } from 'react';
import type { PageContext } from '@forgeline/shared';
import { useLocation } from 'react-router';
import { ui } from './ui-store';

/** Pages describe what the user is looking at so the global assistant can use it. */
export function usePageContext(ctx: Omit<PageContext, 'route'> | null, deps: unknown[] = []): void {
  const location = useLocation();
  useEffect(() => {
    ui.set({ pageContext: ctx ? { route: location.pathname, ...ctx } : { route: location.pathname } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, ...deps]);
}

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Forgeline` : 'Forgeline';
  }, [title]);
}
