import { Injectable } from '@nestjs/common';
import type { AnySdlcTool, ProjectContext } from '@forgeline/integrations';
import type { Permission, RiskLevel } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';

export type PolicySetting = 'auto' | 'required';

export interface PolicyDecision {
  action: string;
  required: boolean;
  /** Locked actions cannot be relaxed by project settings or flow definitions. */
  locked: boolean;
  risk: RiskLevel;
  requiredPermission: Permission;
  allowSelfApproval: boolean;
  reason: string;
}

/** Actions that ALWAYS require a human decision. */
export const LOCKED_ACTIONS: ReadonlySet<string> = new Set(['deploy.production', 'pr.merge', 'infrastructure.destroy']);

/** Defaults for configurable actions (overridable per project via settings.approvalPolicy). */
export const DEFAULT_POLICY: Record<string, PolicySetting> = {
  'ticket.create': 'auto',
  'branch.create': 'auto',
  'code.generate': 'auto',
  'code.commit': 'auto',
  'pr.create': 'auto',
  'docs.publish': 'auto',
  'deploy.development': 'auto',
  'deploy.staging': 'required',
  'deploy.rollback': 'auto',
  'notify.team': 'auto',
};

const ACTION_RISK: Record<string, RiskLevel> = {
  'deploy.production': 'HIGH',
  'pr.merge': 'HIGH',
  'infrastructure.destroy': 'CRITICAL',
  'deploy.staging': 'MEDIUM',
  'pr.create': 'LOW',
};

const ACTION_PERMISSION: Record<string, Permission> = {
  'deploy.production': 'deploy:production',
  'deploy.staging': 'deploy:staging',
  'deploy.development': 'deploy:development',
  'pr.merge': 'code:merge',
  'infrastructure.destroy': 'infrastructure:destroy',
};

/**
 * Human-in-the-loop policy engine. Evaluated by the step runner immediately
 * before a tool executes, so gates cannot be removed by editing a Flow.
 */
@Injectable()
export class ApprovalPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  actionFor(tool: AnySdlcTool, input: unknown): string | undefined {
    return typeof tool.approvalAction === 'function' ? tool.approvalAction(input) : tool.approvalAction;
  }

  async evaluate(organizationId: string, project: ProjectContext | null, requestedAction: string, environmentName?: string | null): Promise<PolicyDecision> {
    let action = requestedAction;
    if (action === 'deploy.environment') {
      // Resolve to the environment type; unknown environments are treated as production (safest).
      const env = project?.environments.find((e) => e.name === environmentName);
      action = `deploy.${(env?.type ?? 'PRODUCTION').toLowerCase()}`;
    }
    const locked = LOCKED_ACTIONS.has(action);
    const projectPolicy = (project?.settings.approvalPolicy ?? {}) as Record<string, PolicySetting>;
    let required = locked || (projectPolicy[action] ?? DEFAULT_POLICY[action] ?? 'auto') === 'required';
    let reason = locked ? `${action} always requires approval` : required ? `Project policy requires approval for ${action}` : `${action} runs automatically`;
    if (environmentName && project) {
      const env = project.environments.find((e) => e.name === environmentName);
      if (env?.requiresApproval && !required) {
        required = true;
        reason = `Environment "${env.name}" requires approval`;
      }
    }
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
    const settings = this.organizations.settingsOf(org.settings);
    const isProd = action === 'deploy.production';
    return {
      action,
      required,
      locked,
      risk: ACTION_RISK[action] ?? 'LOW',
      requiredPermission: ACTION_PERMISSION[action] ?? 'approval:decide',
      allowSelfApproval: !(isProd && settings.fourEyesProduction),
      reason,
    };
  }

  /** Effective policy table for a project (shown in Settings → Approvals). */
  describe(project: ProjectContext | null): { action: string; setting: PolicySetting; locked: boolean }[] {
    const projectPolicy = (project?.settings.approvalPolicy ?? {}) as Record<string, PolicySetting>;
    const actions = new Set([...Object.keys(DEFAULT_POLICY), ...LOCKED_ACTIONS]);
    return [...actions].sort().map((action) => ({
      action,
      locked: LOCKED_ACTIONS.has(action),
      setting: LOCKED_ACTIONS.has(action) ? 'required' : (projectPolicy[action] ?? DEFAULT_POLICY[action] ?? 'auto'),
    }));
  }
}
