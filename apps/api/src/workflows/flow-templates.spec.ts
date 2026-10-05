import { validateWorkflowDefinition } from '@forgeline/workflow-engine';
import { COMMANDS } from '@forgeline/shared';
import { FLOW_TEMPLATES } from './flow-templates';
import { WorkflowsService } from './workflows.service';

describe('built-in flow templates', () => {
  it.each(FLOW_TEMPLATES.map((t) => [t.key, t] as const))('%s is a valid DAG with valid templates and expressions', (_key, t) => {
    const r = validateWorkflowDefinition(t.definition);
    if (!r.valid) throw new Error(r.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
    expect(r.valid).toBe(true);
  });

  it('every command maps to an existing template', () => {
    const keys = new Set(FLOW_TEMPLATES.map((t) => t.key));
    for (const c of COMMANDS) expect(keys).toContain(c.template);
  });

  it('feature delivery gates production and merge behind approvals and repairs failed validation', () => {
    const t = FLOW_TEMPLATES.find((x) => x.key === 'feature_delivery')!;
    const steps = new Map(t.definition.steps.map((s) => [s.key, s]));
    expect(steps.get('deploy_production')?.tool).toBe('deploy.environment');
    expect(steps.get('merge_pr')?.tool).toBe('github.mergePullRequest');
    expect(steps.get('validate_code')?.repair?.step).toBe('fix_code');
    expect(steps.get('deploy_production')?.dependsOn).toEqual(expect.arrayContaining(['merge_pr']));
  });

  it('lays out repair steps after the step they repair', () => {
    const t = FLOW_TEMPLATES.find((x) => x.key === 'feature_delivery')!;
    const r = validateWorkflowDefinition(t.definition);
    if (!r.valid) throw new Error('invalid template');
    const service = Object.create(WorkflowsService.prototype) as WorkflowsService;
    const laid = new Map(service.withLayout(r.definition).steps.map((s) => [s.key, s.ui!]));
    expect(laid.get('fix_code')!.x).toBeGreaterThan(laid.get('validate_code')!.x);
    expect(laid.get('address_review')!.x).toBeGreaterThan(laid.get('fix_code')!.x);
  });
});
