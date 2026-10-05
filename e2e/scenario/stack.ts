/* eslint-disable no-console */
import { startStack } from './harness';

/**
 * Long-running local stack for UI development and browser tests: mock external
 * services on :4010 and the API on :4000 configured to use them.
 *   pnpm --filter @forgeline/e2e stack
 */
async function main() {
  const stack = await startStack({
    apiPort: Number(process.env.API_PORT ?? 4000),
    mockPort: Number(process.env.MOCK_PORT ?? 4010),
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:5173',
  });
  console.log(`API ${stack.apiUrl} · mock services ${stack.mockUrl}`);
  const stop = () => void stack.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
