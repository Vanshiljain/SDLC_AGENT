/* eslint-disable no-console */
import * as argon2 from 'argon2';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Seed data for local development and demos.
 *
 *  - "Forgeline Demo" (isDemo = true): every run is simulated and labelled as
 *    such — no real tickets, PRs or deployments are ever created there.
 *  - "Acme Engineering" (real workspace): empty projects ready for real
 *    integrations to be connected.
 *
 * Re-running the seed is safe (upserts).
 */
const prisma = new PrismaClient();

const PASSWORD = process.env.SEED_PASSWORD ?? 'Forgeline!2026';

const ORG_SETTINGS = { fourEyesProduction: true, defaultTicketProvider: 'JIRA', logRetentionDays: 90 };

async function user(email: string, name: string, hash: string) {
  return prisma.user.upsert({ where: { email }, create: { email, name, passwordHash: hash }, update: { name } });
}

async function org(slug: string, name: string, isDemo: boolean) {
  return prisma.organization.upsert({
    where: { slug },
    create: { slug, name, isDemo, settings: ORG_SETTINGS as Prisma.InputJsonValue },
    update: { name, isDemo },
  });
}

async function project(organizationId: string, p: { name: string; key: string; slug: string; description: string; url: (env: string) => string; repo?: { owner: string; name: string } }) {
  const row = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId, slug: p.slug } },
    create: { organizationId, name: p.name, key: p.key, slug: p.slug, description: p.description, settings: { jiraProjectKey: p.key, ticketProvider: 'JIRA', notionParentPageId: 'demo-parent-page' } as Prisma.InputJsonValue },
    update: { description: p.description },
  });
  for (const [name, type, requiresApproval] of [
    ['development', 'DEVELOPMENT', false],
    ['staging', 'STAGING', false],
    ['production', 'PRODUCTION', true],
  ] as const) {
    await prisma.environment.upsert({
      where: { projectId_name: { projectId: row.id, name } },
      create: {
        organizationId,
        projectId: row.id,
        name,
        type,
        requiresApproval,
        url: p.url(name),
        smokeTests: [
          { name: 'Login page', path: '/login', expectStatus: 200 },
          { name: 'API status', path: '/api/status', expectStatus: 200 },
        ] as Prisma.InputJsonValue,
      },
      update: {},
    });
  }
  if (p.repo) {
    await prisma.repository.upsert({
      where: { projectId_provider_fullName: { projectId: row.id, provider: 'github', fullName: `${p.repo.owner}/${p.repo.name}` } },
      create: {
        organizationId,
        projectId: row.id,
        owner: p.repo.owner,
        name: p.repo.name,
        fullName: `${p.repo.owner}/${p.repo.name}`,
        defaultBranch: 'main',
        url: `https://github.com/${p.repo.owner}/${p.repo.name}`,
        language: 'TypeScript',
        settings: { installCommand: 'npm ci', lintCommand: 'npm run lint', testCommand: 'npm test', ciWorkflow: 'ci.yml', deployWorkflow: 'deploy.yml' } as Prisma.InputJsonValue,
      },
      update: {},
    });
  }
  return row;
}

async function main() {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const admin = await user('admin@forgeline.dev', 'Avery Admin', hash);
  const engineer = await user('engineer@forgeline.dev', 'Eli Engineer', hash);
  const lead = await user('lead@forgeline.dev', 'Lee Release-Lead', hash);

  const demo = await org('forgeline-demo', 'Forgeline Demo', true);
  const acme = await org('acme-engineering', 'Acme Engineering', false);
  for (const [o, u, role] of [
    [demo, admin, 'OWNER'],
    [demo, engineer, 'MEMBER'],
    [demo, lead, 'ADMIN'],
    [acme, admin, 'OWNER'],
    [acme, engineer, 'MEMBER'],
    [acme, lead, 'ADMIN'],
  ] as const) {
    await prisma.membership.upsert({ where: { organizationId_userId: { organizationId: o.id, userId: u.id } }, create: { organizationId: o.id, userId: u.id, role }, update: { role } });
  }

  const platform = await prisma.team.upsert({ where: { organizationId_slug: { organizationId: demo.id, slug: 'platform' } }, create: { organizationId: demo.id, name: 'Platform', slug: 'platform', description: 'Identity, payments and core services' }, update: {} });
  for (const u of [admin, engineer, lead]) await prisma.teamMember.upsert({ where: { teamId_userId: { teamId: platform.id, userId: u.id } }, create: { teamId: platform.id, userId: u.id }, update: {} });

  const demoUrl = (svc: string) => (env: string) => `https://${env === 'production' ? '' : `${env}.`}${svc}.demo.forgeline.invalid`;
  const auth = await project(demo.id, { name: 'Authentication Service', key: 'AUTH', slug: 'authentication-service', description: 'Identity, sessions, OAuth and password management.', url: demoUrl('auth'), repo: { owner: 'forgeline-demo', name: 'auth-service' } });
  const pay = await project(demo.id, { name: 'Payments API', key: 'PAY', slug: 'payments-api', description: 'Checkout, invoicing and payment provider integrations.', url: demoUrl('payments'), repo: { owner: 'forgeline-demo', name: 'payments-api' } });
  for (const p of [auth, pay]) {
    for (const [u, role] of [
      [admin, 'MAINTAINER'],
      [engineer, 'DEVELOPER'],
      [lead, 'MAINTAINER'],
    ] as const) {
      await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: p.id, userId: u.id } }, create: { projectId: p.id, userId: u.id, role }, update: { role } });
    }
    await prisma.project.update({ where: { id: p.id }, data: { teamId: platform.id } });
  }

  const acmeProject = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: acme.id, slug: 'core-platform' } },
    create: { organizationId: acme.id, name: 'Core Platform', key: 'CORE', slug: 'core-platform', description: 'Connect GitHub, Jira and your CI/CD to start delivering with Forgeline.', settings: { jiraProjectKey: 'CORE' } as Prisma.InputJsonValue },
    update: {},
  });
  await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: acmeProject.id, userId: admin.id } }, create: { projectId: acmeProject.id, userId: admin.id, role: 'MAINTAINER' }, update: {} });

  // A saved custom flow in the demo workspace (definition is validated by the API when run).
  await prisma.workflow.upsert({
    where: { organizationId_slug: { organizationId: demo.id, slug: 'ready-for-dev-kickoff' } },
    create: {
      organizationId: demo.id,
      projectId: auth.id,
      slug: 'ready-for-dev-kickoff',
      name: 'Ready-for-Dev kickoff',
      description: 'When a Jira ticket moves to "Ready for Development": analyse it, create a branch, plan the implementation and notify the team.',
      category: 'plan',
      status: 'ACTIVE',
      createdById: admin.id,
      definition: {
        version: 1,
        inputs: { requirement: { type: 'string', required: false, default: 'Ticket ready for development' } },
        variables: {},
        onFailure: 'fail',
        concurrency: 4,
        steps: [
          { key: 'analyze_ticket', name: 'Analyze ticket', type: 'tool', tool: 'ai.draftTicket', input: { requirement: '{{ inputs.requirement }}' }, dependsOn: [], runIf: 'all_success', continueOnError: false, ui: { x: 0, y: 0 } },
          { key: 'create_branch', name: 'Create branch', type: 'tool', tool: 'github.createBranch', input: { branch: "feature/{{ slugify(steps.analyze_ticket.output.summary) }}" }, dependsOn: ['analyze_ticket'], runIf: 'all_success', continueOnError: false, ui: { x: 280, y: 0 } },
          { key: 'plan', name: 'Implementation plan', type: 'tool', tool: 'ai.generatePlan', input: { requirement: '{{ inputs.requirement }}' }, dependsOn: ['analyze_ticket'], runIf: 'all_success', continueOnError: false, ui: { x: 280, y: 130 } },
          { key: 'notify', name: 'Notify developer', type: 'tool', tool: 'notify.team', input: { title: 'Ready for development', message: 'Branch {{ steps.create_branch.output.branch }} and plan are ready.' }, dependsOn: ['create_branch', 'plan'], runIf: 'all_success', continueOnError: false, ui: { x: 560, y: 60 } },
        ],
      } as Prisma.InputJsonValue,
    },
    update: {},
  });

  console.log('Seed complete.');
  console.log(`  Users: admin@forgeline.dev (owner), lead@forgeline.dev (admin), engineer@forgeline.dev (member) — password: ${PASSWORD}`);
  console.log('  Workspaces: "Forgeline Demo" (simulated runs only) and "Acme Engineering" (real integrations).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
