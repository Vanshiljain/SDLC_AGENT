import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { AcceptanceWorkspace } from '../scenario/workspace';
import { STATE_FILE } from './global-setup';

/**
 * The acceptance scenario, driven through the browser exactly as a team would:
 * the engineer asks Forge for the feature, starts the proposed flow, follows it
 * live, approves staging; the release lead approves the merge and production
 * (four-eyes); everything ends with real side effects and a full audit trail.
 */
const ws = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as AcceptanceWorkspace & { mockUrl: string };
const REQUEST = 'Implement a password reset feature for my authentication service';

async function signIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((org) => localStorage.setItem('fl-org', org), ws.orgId);
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(ws.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}

test('password reset: request → proposal → live run → approvals → production', async ({ browser }) => {
  const engineer = await signIn(browser, ws.engineer.email);

  // 1. Ask Forge from the Command Center.
  await engineer.getByLabel('Ask Forge').first().fill(REQUEST);
  await engineer.getByLabel('Ask Forge').first().press('Enter');
  const panel = engineer.getByRole('complementary', { name: 'Forge assistant' });
  await expect(panel.getByText('Proposed flow')).toBeVisible();
  await expect(panel.getByText(/Deploy to production \(deploy.production\)/)).toBeVisible();
  await expect(panel.getByText(/Deploy to staging \(deploy.staging\)/)).toBeVisible();

  // 2. Start the proposed flow and open the live run.
  await panel.getByRole('button', { name: 'Start flow' }).click();
  await panel.getByRole('link', { name: /Open run|Open/ }).last().click();
  await expect(engineer).toHaveURL(/\/executions\//);
  await expect(engineer.getByRole('heading', { level: 1 })).toContainText(/password reset/i);

  // 3. Live progress: the staging gate appears; the engineer approves it.
  const banner = engineer.getByRole('button', { name: /^Waiting for approval: .*staging/i });
  await expect(banner).toBeVisible({ timeout: 4 * 60_000 });
  await banner.click();
  await engineer.getByPlaceholder(/Add a comment/).fill('Staging looks good');
  await engineer.getByRole('button', { name: /^Approve$/ }).click();
  await expect(engineer.getByText('Approved — the run continues')).toBeVisible();
  await engineer.keyboard.press('Escape');

  // 4. The merge gate: the engineer may not approve it (needs code:merge) …
  const mergeBanner = engineer.getByRole('button', { name: /^Waiting for approval: .*Merge/i });
  await expect(mergeBanner).toBeVisible({ timeout: 4 * 60_000 });
  await mergeBanner.click();
  await expect(engineer.getByText(/Requires permission|another approver/)).toBeVisible();
  await engineer.keyboard.press('Escape');

  // … the release lead approves merge, then production (four-eyes) from the Approval Center.
  const lead = await signIn(browser, ws.lead.email);
  for (const gate of [/Merge/i, /production/i]) {
    await expect(async () => {
      await lead.goto('/approvals');
      await lead.getByRole('button', { name: gate }).first().click({ timeout: 5_000 });
    }).toPass({ timeout: 4 * 60_000 });
    await lead.getByRole('button', { name: /^Approve$/ }).click();
    await expect(lead.getByText('Approved — the run continues')).toBeVisible();
  }

  // 5. The engineer watches it finish.
  await expect(engineer.getByTestId('run-status')).toHaveText('Completed', { timeout: 4 * 60_000 });
  await engineer.getByRole('tab', { name: /Side effects/ }).click();
  await expect(engineer.getByText('production', { exact: false }).first()).toBeVisible();
  await engineer.getByRole('tab', { name: 'Timeline' }).click();
  await expect(engineer.getByText(/iteration 2/).first()).toBeVisible();
  // Members don't see the audit log; the release lead (admin) does.
  await expect(engineer.getByRole('tab', { name: 'Audit' })).toHaveCount(0);
  await lead.goto(engineer.url());
  await lead.getByRole('tab', { name: 'Audit' }).click();
  await expect(lead.getByText('workflow.run_completed')).toBeVisible();
  await expect(lead.getByText('approval.approved').first()).toBeVisible();

  // 6. Real side effects in the external systems.
  const state = (await (await fetch(`${ws.mockUrl}/__state`)).json()) as { github: { pulls: { merged: boolean }[] }; devops: { deployments: { environment: string }[] } };
  expect(state.github.pulls.some((p) => p.merged)).toBe(true);
  expect(state.devops.deployments.map((d) => d.environment).sort()).toEqual(['production', 'staging']);
});
