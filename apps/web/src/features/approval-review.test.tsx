import { screen } from '@testing-library/react';
import type { Approval } from '@/api/types';
import { renderWithProviders } from '@/test/render';
import { ApprovalReview } from './approval-review';

const approval = (overrides: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  projectId: 'p',
  executionId: 'e',
  executionStepId: 's',
  title: 'Deploy → production',
  description: 'deploy.production always requires approval.',
  action: 'deploy.production',
  riskLevel: 'HIGH',
  status: 'PENDING',
  requiredPermission: 'deploy:production',
  allowSelfApproval: false,
  requestedById: 'u1',
  decidedById: null,
  decisionComment: null,
  decidedAt: null,
  expiresAt: null,
  createdAt: new Date().toISOString(),
  context: {
    risk: { level: 'LOW', source: 'ai', summary: 'Small, tested change.', factors: [{ factor: 'CI passed', impact: 'positive' }], mitigations: [], recommendation: 'approve' },
    evidence: { ci: { status: 'passed' }, qa: { status: 'passed', passed: 12, failed: 0 }, review: { status: 'passed', critical: 0, high: 0 }, rollbackReady: true, changes: { files: 2, items: ['create src/reset.ts', 'modify src/auth.ts'] } },
  },
  canDecide: true,
  ...overrides,
});

function mockApproval(a: Approval) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('ApprovalReview', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows evidence, risk and decision controls to an eligible approver', async () => {
    mockApproval(approval());
    renderWithProviders(<ApprovalReview approvalId="a1" />);
    expect(await screen.findByText('Small, tested change.')).toBeInTheDocument();
    expect(screen.getByText('CI passed')).toBeInTheDocument();
    expect(screen.getByText('Four-eyes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
  });

  it('explains why the user cannot decide instead of showing buttons', async () => {
    mockApproval(approval({ canDecide: false, cannotDecideReason: 'Four-eyes policy: another approver must decide this request' }));
    renderWithProviders(<ApprovalReview approvalId="a1" />);
    expect(await screen.findByText(/another approver must decide/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });
});
