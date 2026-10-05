import { describe, expect, it } from 'vitest';
import { deployPermissionFor, hasPermission, resolvePermissions } from './permissions';
import { workflowDefinitionSchema, triggerConfigSchema } from './workflow';
import { ToolError } from './errors';

describe('RBAC matrix', () => {
  it('owners and admins can do everything that matters operationally', () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expect(hasPermission(role, 'deploy:production')).toBe(true);
      expect(hasPermission(role, 'integration:manage')).toBe(true);
      expect(hasPermission(role, 'audit:read')).toBe(true);
    }
  });

  it('members cannot deploy to production, merge, or manage integrations at org level', () => {
    expect(hasPermission('MEMBER', 'deploy:production')).toBe(false);
    expect(hasPermission('MEMBER', 'code:merge')).toBe(false);
    expect(hasPermission('MEMBER', 'integration:manage')).toBe(false);
    expect(hasPermission('MEMBER', 'workflow:execute')).toBe(true);
  });

  it('viewers are read-only', () => {
    const perms = resolvePermissions('VIEWER');
    expect([...perms].every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('project roles add scoped permissions (maintainers may ship to production)', () => {
    expect(hasPermission('MEMBER', 'deploy:production', 'MAINTAINER')).toBe(true);
    expect(hasPermission('MEMBER', 'code:merge', 'MAINTAINER')).toBe(true);
    expect(hasPermission('MEMBER', 'deploy:staging', 'DEVELOPER')).toBe(true);
    expect(hasPermission('MEMBER', 'deploy:production', 'DEVELOPER')).toBe(false);
  });

  it('maps environment types to deploy permissions', () => {
    expect(deployPermissionFor('PRODUCTION')).toBe('deploy:production');
    expect(deployPermissionFor('STAGING')).toBe('deploy:staging');
    expect(deployPermissionFor('DEVELOPMENT')).toBe('deploy:development');
  });
});

describe('workflow definition schema', () => {
  it('applies safe defaults', () => {
    const d = workflowDefinitionSchema.parse({ steps: [{ key: 'a', name: 'A', tool: 'notify.team' }] });
    expect(d.steps[0]).toMatchObject({ type: 'tool', runIf: 'all_success', dependsOn: [], continueOnError: false });
    expect(d.onFailure).toBe('fail');
  });

  it('rejects malformed keys and empty flows', () => {
    expect(workflowDefinitionSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ steps: [{ key: 'Bad-Key', name: 'x' }] }).success).toBe(false);
  });

  it('validates trigger configurations', () => {
    expect(triggerConfigSchema.safeParse({ type: 'SCHEDULE', cron: '0 9 * * 1-5' }).success).toBe(true);
    expect(
      triggerConfigSchema.safeParse({ type: 'EVENT', event: 'jira.issue.transitioned', filter: "event.toStatus == 'Done'" }).success,
    ).toBe(true);
    expect(triggerConfigSchema.safeParse({ type: 'SCHEDULE' }).success).toBe(false);
  });
});

describe('ToolError', () => {
  it('classifies transient failures as retryable', () => {
    expect(new ToolError('rate_limit', 'slow down').retryable).toBe(true);
    expect(new ToolError('validation', 'bad input').retryable).toBe(false);
    const net = ToolError.from(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }), 'github');
    expect(net.kind).toBe('network');
    expect(net.provider).toBe('github');
  });
});
