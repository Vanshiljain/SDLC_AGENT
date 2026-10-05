import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORTS } from '../playwright.config';
import { startStack } from '../scenario/harness';
import { createAcceptanceWorkspace } from '../scenario/workspace';

export const STATE_FILE = join(__dirname, '..', '.ui-state.json');

export default async function globalSetup() {
  const stack = await startStack({ apiPort: PORTS.api, mockPort: PORTS.mocks, webAppUrl: `http://localhost:${PORTS.web}` });
  const workspace = await createAcceptanceWorkspace(stack.apiUrl, stack.mockUrl);
  writeFileSync(STATE_FILE, JSON.stringify({ ...workspace, apiUrl: stack.apiUrl, mockUrl: stack.mockUrl }, null, 2));
  return async () => {
    await stack.stop();
  };
}
