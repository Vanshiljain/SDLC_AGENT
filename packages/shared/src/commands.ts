import type { Permission } from './permissions';

/**
 * Commands are the reusable business actions behind "do anything from
 * anywhere": chat, the command palette, page buttons, webhooks and schedules
 * all dispatch the same commands to the API's CommandBus.
 */
export interface CommandInputSpec {
  name: string;
  label: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'project' | 'repository' | 'environment' | 'pull_request' | 'ticket';
  required: boolean;
  placeholder?: string;
}

export interface CommandDefinition {
  id: string;
  title: string;
  description: string;
  category: 'deliver' | 'plan' | 'code' | 'quality' | 'release' | 'docs' | 'tickets' | 'comms' | 'knowledge';
  /** Flow template started by this command. */
  template: string;
  permission: Permission;
  inputs: CommandInputSpec[];
  keywords: string[];
}

export const COMMANDS: readonly CommandDefinition[] = [
  {
    id: 'feature.deliver',
    title: 'Deliver a feature end-to-end',
    description: 'Ticket → spec → plan → branch → code → tests → review → PR → CI → QA → staging → production, with gates.',
    category: 'deliver',
    template: 'feature_delivery',
    permission: 'workflow:execute',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'requirement', label: 'What should be built?', type: 'text', required: true },
    ],
    keywords: ['implement', 'build', 'feature', 'ship', 'deliver', 'end to end'],
  },
  {
    id: 'ticket.create',
    title: 'Create Jira ticket',
    description: 'Draft a well-structured ticket with acceptance criteria and create it in Jira.',
    category: 'tickets',
    template: 'create_ticket',
    permission: 'ticket:write',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'requirement', label: 'Ticket description', type: 'text', required: true },
    ],
    keywords: ['jira', 'ticket', 'issue', 'story', 'create ticket'],
  },
  {
    id: 'spec.generate',
    title: 'Generate technical specification',
    description: 'Analyse a ticket or requirement with project context and write a technical spec.',
    category: 'plan',
    template: 'technical_spec',
    permission: 'agent:use',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'requirement', label: 'Requirement or ticket key', type: 'text', required: true },
    ],
    keywords: ['spec', 'specification', 'analyze ticket', 'design'],
  },
  {
    id: 'plan.generate',
    title: 'Generate implementation plan',
    description: 'Identify affected files and produce a step-by-step implementation plan.',
    category: 'plan',
    template: 'implementation_plan',
    permission: 'agent:use',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'requirement', label: 'Requirement', type: 'text', required: true },
    ],
    keywords: ['plan', 'implementation plan', 'breakdown'],
  },
  {
    id: 'code.generate',
    title: 'Generate code & open PR',
    description: 'Generate the change on a new branch, validate with lint/tests, commit and open a pull request.',
    category: 'code',
    template: 'implement_change',
    permission: 'code:write',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'requirement', label: 'Change to implement', type: 'text', required: true },
    ],
    keywords: ['code', 'generate code', 'implement', 'branch', 'commit', 'pull request'],
  },
  {
    id: 'pr.review',
    title: 'Review pull request',
    description: 'AI code review for correctness, security, performance and tests; posts results to GitHub.',
    category: 'quality',
    template: 'review_pull_request',
    permission: 'agent:use',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'pullNumber', label: 'Pull request number', type: 'pull_request', required: true },
    ],
    keywords: ['review', 'pr', 'pull request', 'code review', 'security review'],
  },
  {
    id: 'qa.run',
    title: 'Run QA',
    description: 'Generate test cases, run the suite, analyse failures and report.',
    category: 'quality',
    template: 'run_qa',
    permission: 'qa:run',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'ref', label: 'Branch or commit', type: 'string', required: false, placeholder: 'main' },
    ],
    keywords: ['qa', 'test', 'tests', 'run tests', 'quality'],
  },
  {
    id: 'ci.run',
    title: 'Run CI/CD pipeline',
    description: 'Trigger the configured CI pipeline and analyse the result.',
    category: 'release',
    template: 'run_ci',
    permission: 'workflow:execute',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'ref', label: 'Branch', type: 'string', required: false, placeholder: 'main' },
    ],
    keywords: ['ci', 'pipeline', 'github actions', 'build'],
  },
  {
    id: 'deploy.environment',
    title: 'Deploy',
    description: 'Build, verify and deploy to an environment with health checks, smoke tests and auto-rollback.',
    category: 'release',
    template: 'deploy',
    permission: 'deploy:staging',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'environment', label: 'Environment', type: 'environment', required: true },
      { name: 'ref', label: 'Branch, tag or commit', type: 'string', required: false, placeholder: 'main' },
    ],
    keywords: ['deploy', 'release', 'staging', 'production', 'ship'],
  },
  {
    id: 'deploy.rollback',
    title: 'Roll back deployment',
    description: 'Roll an environment back to the previous successful deployment.',
    category: 'release',
    template: 'rollback',
    permission: 'deploy:staging',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'environment', label: 'Environment', type: 'environment', required: true },
    ],
    keywords: ['rollback', 'revert deployment', 'undo deploy'],
  },
  {
    id: 'docs.generate',
    title: 'Generate documentation',
    description: 'Write documentation from code and context and publish it to Notion.',
    category: 'docs',
    template: 'generate_docs',
    permission: 'docs:write',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'topic', label: 'Topic', type: 'text', required: true },
    ],
    keywords: ['docs', 'documentation', 'notion', 'write docs'],
  },
  {
    id: 'team.notify',
    title: 'Notify the team',
    description: 'Send an update to the team channel and in-app notifications.',
    category: 'comms',
    template: 'notify_team',
    permission: 'notify:send',
    inputs: [
      { name: 'projectId', label: 'Project', type: 'project', required: true },
      { name: 'message', label: 'Message', type: 'text', required: true },
    ],
    keywords: ['notify', 'announce', 'slack', 'tell the team'],
  },
];

export function findCommand(id: string): CommandDefinition | undefined {
  return COMMANDS.find((c) => c.id === id);
}
