import { render, screen } from '@testing-library/react';
import { TooltipProvider } from './menu';
import { ForgeProgress, ModeBadge, StatusBadge } from './status';

describe('status components', () => {
  it('labels statuses in plain language', () => {
    render(<StatusBadge status="WAITING_APPROVAL" />);
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
  });

  it('marks simulated (demo) runs and nothing else', () => {
    const { rerender, container } = render(
      <TooltipProvider>
        <ModeBadge mode="DEMO" />
      </TooltipProvider>,
    );
    expect(screen.getByText('Simulated')).toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <ModeBadge mode="LIVE" />
      </TooltipProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('draws one segment per non-skipped step and animates live ones', () => {
    const { container } = render(
      <TooltipProvider>
        <ForgeProgress steps={[{ status: 'COMPLETED' }, { status: 'RUNNING' }, { status: 'SKIPPED' }, { status: 'PENDING' }]} />
      </TooltipProvider>,
    );
    const segments = container.querySelectorAll('span.rounded-full');
    expect(segments).toHaveLength(3);
    expect(container.querySelectorAll('.forge-line')).toHaveLength(1);
  });
});
