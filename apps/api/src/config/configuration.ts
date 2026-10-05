import { z } from 'zod';

/**
 * Typed, validated configuration. Every environment-specific value lives here;
 * the app fails fast at boot when required values are missing or malformed.
 */
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: csv,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: bool(false),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('bullmq'),
  /** BullMQ queue name — separate environments sharing one Redis must use different names. */
  QUEUE_NAME: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default('forgeline'),
  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().default('forgeline_knowledge'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_ORGANIZATION: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  OPENAI_MODEL_PLANNER: z.string().optional(),
  OPENAI_MODEL_CODER: z.string().optional(),
  OPENAI_MODEL_REVIEWER: z.string().optional(),
  OPENAI_MODEL_FAST: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().default(2),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().default(14),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().optional(),

  /** Comma-separated "version:base64key" pairs; highest version encrypts. */
  ENCRYPTION_KEYS: z.string().min(1, 'ENCRYPTION_KEYS is required (e.g. "1:<base64 32-byte key>")'),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(20),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.string().url().default('https://github.com'),
  JIRA_CLIENT_ID: z.string().optional(),
  JIRA_CLIENT_SECRET: z.string().optional(),
  ATLASSIAN_AUTH_URL: z.string().url().default('https://auth.atlassian.com'),
  ATLASSIAN_API_URL: z.string().url().default('https://api.atlassian.com'),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  NOTION_API_URL: z.string().url().default('https://api.notion.com/v1'),
  TRELLO_API_KEY: z.string().optional(),
  TRELLO_API_SECRET: z.string().optional(),
  TRELLO_API_URL: z.string().url().default('https://api.trello.com/1'),
  TRELLO_WEB_URL: z.string().url().default('https://trello.com'),

  SANDBOX_DRIVER: z.enum(['docker', 'local', 'disabled']).default('disabled'),
  SANDBOX_DEFAULT_IMAGE: z.string().default('node:22-bookworm'),
  SANDBOX_WORKDIR: z.string().default('/tmp/forgeline-sandbox'),
  SANDBOX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(15 * 60_000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().default(4096),
  SANDBOX_CPUS: z.coerce.number().default(2),
  SANDBOX_NETWORK: z.enum(['none', 'bridge']).default('bridge'),

  OUTBOUND_ALLOW_PRIVATE_NETWORKS: bool(false),
  OUTBOUND_ALLOWED_HOSTS: csv,

  DEMO_MODE_ENABLED: bool(true),
  SENTRY_DSN: z.string().optional(),
  METRICS_ENABLED: bool(true),
  METRICS_TOKEN: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().default(8),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  role: Env['APP_ROLE'];
  port: number;
  apiPublicUrl: string;
  webAppUrl: string;
  corsOrigins: string[];
  logLevel: Env['LOG_LEVEL'];
  trustProxy: boolean;
  databaseUrl: string;
  redisUrl: string;
  queueDriver: Env['QUEUE_DRIVER'];
  queueName: string;
  qdrant: { url: string; apiKey?: string; collection: string };
  ai: {
    apiKey?: string;
    baseUrl?: string;
    organization?: string;
    model: string;
    roleModels: { planner?: string; coder?: string; reviewer?: string; fast?: string };
    embeddingModel: string;
    embeddingDimensions: number;
    temperature?: number;
    timeoutMs: number;
    maxRetries: number;
  };
  jwt: { secret: string; refreshSecret: string; accessTtlSeconds: number; refreshTtlDays: number };
  cookies: { secure: boolean; domain?: string };
  encryptionKeys: string;
  rateLimit: { ttlSeconds: number; max: number; authMax: number };
  oauth: {
    github: { clientId?: string; clientSecret?: string; apiUrl: string; webUrl: string };
    jira: { clientId?: string; clientSecret?: string; authUrl: string; apiUrl: string };
    notion: { clientId?: string; clientSecret?: string; apiUrl: string };
    trello: { apiKey?: string; apiSecret?: string; apiUrl: string; webUrl: string };
  };
  sandbox: {
    driver: Env['SANDBOX_DRIVER'];
    defaultImage: string;
    workdir: string;
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
    network: Env['SANDBOX_NETWORK'];
  };
  outbound: { allowPrivateNetworks: boolean; allowedHosts: string[] };
  demoModeEnabled: boolean;
  sentryDsn?: string;
  metrics: { enabled: boolean; token?: string };
  workerConcurrency: number;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Empty values in .env files mean "unset".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    if (e.JWT_SECRET === e.JWT_REFRESH_SECRET) throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must differ in production');
    if (!e.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (e.SANDBOX_DRIVER === 'local') throw new Error('SANDBOX_DRIVER=local is not allowed in production (use docker)');
  }
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    role: e.APP_ROLE,
    port: e.PORT,
    apiPublicUrl: e.API_PUBLIC_URL.replace(/\/+$/, ''),
    webAppUrl: e.WEB_APP_URL.replace(/\/+$/, ''),
    corsOrigins: e.CORS_ORIGINS.length ? e.CORS_ORIGINS : [e.WEB_APP_URL.replace(/\/+$/, '')],
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    queueDriver: e.QUEUE_DRIVER,
    queueName: e.QUEUE_NAME,
    qdrant: { url: e.QDRANT_URL, apiKey: e.QDRANT_API_KEY, collection: e.QDRANT_COLLECTION },
    ai: {
      apiKey: e.OPENAI_API_KEY || undefined,
      baseUrl: e.OPENAI_BASE_URL,
      organization: e.OPENAI_ORGANIZATION,
      model: e.OPENAI_MODEL,
      roleModels: {
        planner: e.OPENAI_MODEL_PLANNER,
        coder: e.OPENAI_MODEL_CODER,
        reviewer: e.OPENAI_MODEL_REVIEWER,
        fast: e.OPENAI_MODEL_FAST,
      },
      embeddingModel: e.OPENAI_EMBEDDING_MODEL,
      embeddingDimensions: e.OPENAI_EMBEDDING_DIMENSIONS,
      temperature: e.OPENAI_TEMPERATURE,
      timeoutMs: e.OPENAI_TIMEOUT_MS,
      maxRetries: e.OPENAI_MAX_RETRIES,
    },
    jwt: {
      secret: e.JWT_SECRET,
      refreshSecret: e.JWT_REFRESH_SECRET,
      accessTtlSeconds: e.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: e.JWT_REFRESH_TTL_DAYS,
    },
    cookies: { secure: e.COOKIE_SECURE, domain: e.COOKIE_DOMAIN },
    encryptionKeys: e.ENCRYPTION_KEYS,
    rateLimit: { ttlSeconds: e.RATE_LIMIT_TTL_SECONDS, max: e.RATE_LIMIT_MAX, authMax: e.AUTH_RATE_LIMIT_MAX },
    oauth: {
      github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET, apiUrl: e.GITHUB_API_URL, webUrl: e.GITHUB_WEB_URL },
      jira: { clientId: e.JIRA_CLIENT_ID, clientSecret: e.JIRA_CLIENT_SECRET, authUrl: e.ATLASSIAN_AUTH_URL, apiUrl: e.ATLASSIAN_API_URL },
      notion: { clientId: e.NOTION_CLIENT_ID, clientSecret: e.NOTION_CLIENT_SECRET, apiUrl: e.NOTION_API_URL },
      trello: { apiKey: e.TRELLO_API_KEY, apiSecret: e.TRELLO_API_SECRET, apiUrl: e.TRELLO_API_URL, webUrl: e.TRELLO_WEB_URL },
    },
    sandbox: {
      driver: e.SANDBOX_DRIVER,
      defaultImage: e.SANDBOX_DEFAULT_IMAGE,
      workdir: e.SANDBOX_WORKDIR,
      timeoutMs: e.SANDBOX_TIMEOUT_MS,
      memoryMb: e.SANDBOX_MEMORY_MB,
      cpus: e.SANDBOX_CPUS,
      network: e.SANDBOX_NETWORK,
    },
    outbound: { allowPrivateNetworks: e.OUTBOUND_ALLOW_PRIVATE_NETWORKS, allowedHosts: e.OUTBOUND_ALLOWED_HOSTS },
    demoModeEnabled: e.DEMO_MODE_ENABLED,
    sentryDsn: e.SENTRY_DSN,
    metrics: { enabled: e.METRICS_ENABLED, token: e.METRICS_TOKEN },
    workerConcurrency: e.WORKER_CONCURRENCY,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
