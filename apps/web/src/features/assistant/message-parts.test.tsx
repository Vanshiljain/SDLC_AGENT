import { screen } from '@testing-library/react';
import type { FlowProposalPart } from '@forgeline/shared';
import type { Message } from '@/api/types';
import { renderWithProviders } from '@/test/render';
import { MessageParts } from './message-parts';

const proposal = (overrides: Partial<FlowProposalPart> = {}): FlowProposalPart => ({
  type: 'flow_proposal',
  proposalId: 'p1',
  title: 'Password reset',
  summary: 'Full delivery',
  projectId: 'proj',
  steps: [
    { key: 'ticket', name: 'Create ticket', type: 'tool', dependsOn: [], requiresApproval: false },
    { key: 'deploy_production', name: 'Deploy to production', type: 'tool', dependsOn: ['ticket'], requiresApproval: true },
  ],
  approvalsRequired: ['deploy.production'],
  missingIntegrations: [],
  state: 'proposed',
  mode: 'LIVE',
  ...overrides,
});

const message = (parts: Message['parts']): Message => ({
  id: 'm1',
  conversationId: 'c1',
  role: 'ASSISTANT',
  content: '',
  parts,
  status: 'complete',
  executionId: null,
  createdAt: new Date().toISOString(),
});

describe('assistant message parts', () => {
  it('shows the plan, the approvals it needs, and lets the user start it', () => {
    renderWithProviders(<MessageParts conversationId="c1" message={message([{ type: 'text', text: 'Here is the plan.' }, proposal()])} />);
    expect(screen.getByText('Here is the plan.')).toBeInTheDocument();
    expect(screen.getByText('Deploy to production')).toBeInTheDocument();
    expect(screen.getByText('deploy.production')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start flow/i })).toBeEnabled();
  });

  it('blocks starting when required integrations are missing', () => {
    renderWithProviders(<MessageParts conversationId="c1" message={message([proposal({ missingIntegrations: ['JIRA'] })])} />);
    expect(screen.getByText(/connect first/i)).toBeInTheDocument();
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start flow/i })).toBeDisabled();
  });

  it('labels demo proposals as simulated', () => {
    renderWithProviders(<MessageParts conversationId="c1" message={message([proposal({ mode: 'DEMO' })])} />);
    expect(screen.getByText('Simulated')).toBeInTheDocument();
  });

  it('renders tool activity and errors honestly', () => {
    renderWithProviders(
      <MessageParts
        conversationId="c1"
        message={message([
          { type: 'tool_call', callId: 't1', tool: 'search_knowledge', title: 'Searched knowledge', status: 'succeeded' },
          { type: 'error', message: 'The model provider is unavailable', retryable: true },
        ])}
      />,
    );
    expect(screen.getByText('Searched knowledge')).toBeInTheDocument();
    expect(screen.getByText('The model provider is unavailable')).toBeInTheDocument();
  });
});
