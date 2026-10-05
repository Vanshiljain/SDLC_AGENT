/**
 * Integration tests boot the real AppModule against the local Postgres/Redis/Qdrant
 * (see docker-compose.dev.yml). Work runs in-process (inline queue) so assertions
 * can await completion deterministically. Base values come from ../../.env via
 * dotenv-cli; these overrides make the run hermetic.
 */
process.env.NODE_ENV = 'test';
process.env.QUEUE_DRIVER = 'inline';
process.env.LOG_LEVEL = 'fatal';
process.env.APP_ROLE = 'all';
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS = 'false';
process.env.SANDBOX_DRIVER = 'disabled';
// No LLM in integration tests: features must degrade honestly without one.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
