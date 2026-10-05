import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/menu';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { qc, ...render(ui, { wrapper: Wrapper }) };
}
