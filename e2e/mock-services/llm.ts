import { createHash } from 'node:crypto';
import { GENERATED_QA_TEST, GENERATED_RESET_BUGGY, GENERATED_RESET_FIXED, GENERATED_RESET_TEST } from './repo-fixture';

/**
 * Deterministic OpenAI-compatible model for end-to-end tests. Responses are
 * keyed by the structured-output schema name; tool-calling turns emulate the
 * orchestrator calling `propose_flow`. It produces real, runnable code so the
 * sandbox validation and repair loop execute genuinely.
 */

type Json = Record<string, unknown>;

const structured: Record<string, (ctx: { calls: number; prompt: string }) => Json> = {
  ticket_draft: () => ({
    summary: 'Implement password reset for the authentication service',
    issueType: 'Story',
    priority: 'High',
    description: '## Context\nUsers cannot recover their accounts without support.\n\n## Scope\n- Request a reset token\n- Consume a single-use token\n\n## Technical notes\nReuse `hashToken` from `src/auth.js`; store only token hashes.',
    acceptanceCriteria: ['Reset tokens are single use', 'Reset tokens expire after 30 minutes', 'Only token hashes are stored'],
    labels: ['auth', 'security'],
  }),
  technical_spec: () => ({
    title: 'Password reset',
    summary: 'Self-service password reset with single-use, expiring tokens.',
    problem: 'Users who forget passwords need support intervention.',
    goals: ['Self-service reset', 'Secure token lifecycle'],
    nonGoals: ['SMS recovery'],
    approach: 'Add `src/password-reset.js` reusing `hashToken` from `src/auth.js`. Tokens are random 32-byte values; only SHA-256 hashes are stored with a 30 minute TTL.',
    components: [{ name: 'password-reset', responsibility: 'Token lifecycle', changes: 'New module' }],
    apiChanges: [],
    dataModelChanges: [{ entity: 'ResetTokenStore', change: 'In-memory map keyed by token hash' }],
    security: ['Store only hashes', 'Single use', 'Expiry enforced'],
    testing: ['Unit tests with node --test'],
    risks: [{ risk: 'Clock skew', mitigation: 'Inject `now` for testability' }],
    openQuestions: [],
    rollout: 'Staging first, then production behind approval.',
  }),
  implementation_plan: () => ({
    summary: 'Add a password-reset module with tests.',
    branchName: 'feature/password-reset',
    complexity: 'low',
    affectedFiles: [
      { path: 'src/password-reset.js', action: 'create', reason: 'Token lifecycle' },
      { path: 'test/password-reset.test.js', action: 'create', reason: 'Unit tests' },
    ],
    steps: [{ title: 'Implement module', detail: 'createResetToken / consumeResetToken', files: ['src/password-reset.js'] }],
    testPlan: ['Single use', 'Expiry', 'Unknown tokens'],
    risks: [],
  }),
  code_change_set: () => ({
    summary: 'Add password reset token module and tests',
    commitMessage: 'feat(auth): add password reset tokens',
    files: [
      { path: 'src/password-reset.js', action: 'create', content: GENERATED_RESET_BUGGY, explanation: 'Token lifecycle' },
      { path: 'test/password-reset.test.js', action: 'create', content: GENERATED_RESET_TEST, explanation: 'Unit tests' },
    ],
    testsAdded: ['test/password-reset.test.js'],
    notes: [],
  }),
  code_fix: () => ({
    summary: 'Reject expired reset tokens',
    commitMessage: 'fix(auth): enforce reset token expiry',
    files: [{ path: 'src/password-reset.js', action: 'modify', content: GENERATED_RESET_FIXED, explanation: 'Add expiry check' }],
    testsAdded: [],
    notes: [],
  }),
  failure_analysis: () => ({
    summary: 'Expired tokens are accepted',
    rootCause: 'consumeResetToken does not compare the current time with expiresAt.',
    category: 'code_bug',
    confidence: 0.92,
    affectedFiles: ['src/password-reset.js'],
    suggestedFix: 'Return null when now > record.expiresAt.',
    shouldAttemptFix: true,
  }),
  code_review: () => ({
    summary: 'Solid, minimal change. Consider rate limiting reset requests at the API layer.',
    verdict: 'COMMENT',
    riskLevel: 'LOW',
    findings: [{ severity: 'MEDIUM', category: 'SECURITY', file: 'src/password-reset.js', line: 8, title: 'Rate-limit token creation', detail: 'Token creation should be rate limited per account to prevent abuse.', suggestion: 'Apply the existing throttling middleware to the reset endpoint.' }],
    dimensions: { security: 'warning', performance: 'passed', architecture: 'passed', tests: 'passed', maintainability: 'passed' },
    testCoverageGaps: [],
  }),
  pull_request_description: () => ({ title: 'feat(auth): password reset tokens', body: '## Summary\nAdds single-use, expiring password reset tokens.\n\n## Testing\n`npm test`' }),
  qa_test_plan: () => ({
    summary: 'Token format, storage and lifecycle',
    testCases: [
      { id: 'TC-1', title: 'Token is consumed once', type: 'UNIT', priority: 'P0', preconditions: null, steps: ['Create token', 'Consume twice'], expected: 'Second consume returns null' },
      { id: 'TC-2', title: 'Expired token rejected', type: 'UNIT', priority: 'P0', preconditions: null, steps: ['Create token', 'Advance time'], expected: 'null' },
      { id: 'TC-3', title: 'Token stored hashed', type: 'REGRESSION', priority: 'P1', preconditions: null, steps: ['Create token'], expected: 'Raw token not a store key' },
    ],
    automatedTests: [{ path: 'test/password-reset.qa.test.js', content: GENERATED_QA_TEST, description: 'Token format and hashing' }],
  }),
  risk_assessment: () => ({ level: 'LOW', summary: 'Small, tested change with automatic rollback.', factors: [{ factor: 'Small diff', impact: 'positive' }], recommendation: 'approve', mitigations: [] }),
  document_draft: () => ({ title: 'Password reset', type: 'GUIDE', markdown: '# Password reset\n\nTokens are single use, hashed at rest and expire after 30 minutes.\n\n## Usage\n```js\nconst token = createResetToken(store, userId);\n```' }),
  flow_plan: ({ prompt }) => {
    const request = /Request: ([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? 'Implement password reset';
    return { title: 'Password reset for Auth Service', summary: 'Full delivery: ticket, spec, code, review, CI, QA, staging, docs and production.', template: 'feature_delivery', inputs: [{ name: 'requirement', value: request }], customSteps: [], needsConfirmation: true };
  },
  command_route: () => ({ kind: 'command', commandId: 'deploy.environment', route: null, inputs: [{ name: 'environment', value: 'staging' }], confidence: 0.9, explanation: 'Deploy to staging' }),
  generated_workflow: () => ({
    name: 'Ready for development kickoff',
    description: 'Analyse ticket, branch, plan, notify',
    trigger: { type: 'EVENT', event: 'jira.issue.transitioned', filter: "event.toStatus == 'Ready for Development'", cron: null },
    steps: [
      { key: 'analyze', name: 'Analyze ticket', type: 'tool', tool: 'ai.draftTicket', dependsOn: [], inputJson: '{"requirement":"{{ event.issue.fields.summary }}"}', when: null, approvalTitle: null },
      { key: 'branch', name: 'Create branch', type: 'tool', tool: 'github.createBranch', dependsOn: ['analyze'], inputJson: '{"branch":"feature/{{ slugify(steps.analyze.output.summary) }}"}', when: null, approvalTitle: null },
      { key: 'notify', name: 'Notify developer', type: 'tool', tool: 'notify.team', dependsOn: ['branch'], inputJson: '{"title":"Ready","message":"Branch created"}', when: null, approvalTitle: null },
    ],
  }),
};

export interface ChatRequest {
  model: string;
  messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { type: string; function: { name: string } }[];
  response_format?: { type: string; json_schema?: { name: string } };
  stream?: boolean;
}

const calls = new Map<string, number>();

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: string }).text) : '')).join('');
  return '';
}

export interface ChatResult {
  content: string | null;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

export function respond(req: ChatRequest): ChatResult {
  const prompt = req.messages.map((m) => text(m.content)).join('\n');
  const name = req.response_format?.json_schema?.name;
  if (name) {
    const n = (calls.get(name) ?? 0) + 1;
    calls.set(name, n);
    const build = structured[name];
    if (!build) return { content: JSON.stringify({}) };
    return { content: JSON.stringify(build({ calls: n, prompt })) };
  }
  if (req.tools?.length) {
    const last = req.messages[req.messages.length - 1]!;
    if (last.role === 'tool') {
      const result = text(last.content);
      const started = /"started":true/.test(result);
      return { content: started ? 'I started the delivery flow. You can follow every step live; I will ask for approval before staging, merging and production.' : 'I prepared a delivery plan for **Password reset**. It creates the ticket, writes the spec and code, validates and reviews it, opens a PR, runs CI and QA, and deploys to staging and production with approval gates. Start it from the card below when ready.' };
    }
    const userMessage = text(last.content);
    if (/password reset|implement|deploy|build/i.test(userMessage)) {
      return { content: null, toolCalls: [{ id: `call_${Date.now()}`, name: 'propose_flow', arguments: JSON.stringify({ request: userMessage, startImmediately: false }) }] };
    }
    return { content: `Hello! I can plan and deliver engineering work. You said: "${userMessage.slice(0, 80)}"` };
  }
  return { content: 'Password reset' };
}

export function usage() {
  return { prompt_tokens: 420, completion_tokens: 180, total_tokens: 600 };
}

/** Deterministic embeddings (bag of hashed words), unit-normalised. */
export function embed(input: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of input.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = createHash('md5').update(word).digest();
    v[h.readUInt32BE(0) % dims]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function resetLlm(): void {
  calls.clear();
}
