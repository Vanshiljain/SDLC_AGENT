import { Inject, Injectable, Logger } from '@nestjs/common';
import { ToolError, type IntegrationProvider } from '@forgeline/shared';
import { DEFAULT_OAUTH_ENDPOINTS, refreshAccessToken, type OAuthEndpoints } from '@forgeline/integrations';
import { PrismaService } from '../common/prisma/prisma.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { RedisService } from '../common/redis/redis.provider';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

/** Decrypted credential bundles by provider. Never serialised to clients. */
export type CredentialBundle =
  | { kind: 'github_oauth'; accessToken: string; refreshToken?: string }
  | { kind: 'github_pat'; token: string }
  | { kind: 'jira_oauth'; accessToken: string; refreshToken?: string }
  | { kind: 'jira_basic'; email: string; apiToken: string }
  | { kind: 'trello'; apiKey?: string; token: string }
  | { kind: 'notion'; accessToken: string; refreshToken?: string }
  | { kind: 'devops'; apiToken: string; signingSecret?: string }
  | { kind: 'slack'; webhookUrl: string };

const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Encrypted credential storage. The integration id is bound as AES-GCM
 * associated data so a ciphertext cannot be swapped between integrations.
 */
@Injectable()
export class CredentialVault {
  private readonly logger = new Logger(CredentialVault.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EncryptionService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  oauthEndpoints(): OAuthEndpoints {
    return {
      ...DEFAULT_OAUTH_ENDPOINTS,
      githubWebUrl: this.config.oauth.github.webUrl,
      githubApiUrl: this.config.oauth.github.apiUrl,
      atlassianAuthUrl: this.config.oauth.jira.authUrl,
      atlassianApiUrl: this.config.oauth.jira.apiUrl,
      notionApiUrl: this.config.oauth.notion.apiUrl,
      trelloWebUrl: this.config.oauth.trello.webUrl,
    };
  }

  async store(integrationId: string, bundle: CredentialBundle, expiresAt?: Date | null): Promise<void> {
    const enc = this.crypto.encryptJson(bundle, integrationId);
    await this.prisma.integrationCredential.upsert({
      where: { integrationId },
      create: { integrationId, ciphertext: enc.ciphertext, keyVersion: enc.keyVersion, expiresAt: expiresAt ?? null },
      update: { ciphertext: enc.ciphertext, keyVersion: enc.keyVersion, expiresAt: expiresAt ?? null, rotatedAt: new Date() },
    });
  }

  async remove(integrationId: string): Promise<void> {
    await this.prisma.integrationCredential.deleteMany({ where: { integrationId } });
  }

  /** Load and decrypt; transparently refresh OAuth tokens that are about to expire. */
  async load(integrationId: string, provider: IntegrationProvider): Promise<CredentialBundle> {
    const row = await this.prisma.integrationCredential.findUnique({ where: { integrationId } });
    if (!row) throw new ToolError('not_configured', `${provider} credentials are missing; reconnect the integration`, { retryable: false });
    let bundle = this.crypto.decryptJson<CredentialBundle>({ ciphertext: row.ciphertext, keyVersion: row.keyVersion }, integrationId);
    if (this.crypto.needsRotation({ ciphertext: row.ciphertext, keyVersion: row.keyVersion })) {
      await this.store(integrationId, bundle, row.expiresAt);
    }
    if (row.expiresAt && row.expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS && 'refreshToken' in bundle && bundle.refreshToken) {
      bundle = await this.refreshWithLock(integrationId, provider, bundle);
    }
    return bundle;
  }

  /**
   * Refresh under a distributed lock: providers like Atlassian rotate refresh
   * tokens, so two concurrent refreshes would invalidate each other.
   */
  private async refreshWithLock(integrationId: string, provider: IntegrationProvider, bundle: CredentialBundle): Promise<CredentialBundle> {
    const lockKey = `forgeline:lock:integration-refresh:${integrationId}`;
    const token = EncryptionService.randomToken(8);
    for (let i = 0; i < 20; i++) {
      const acquired = await this.redis.client.set(lockKey, token, 'PX', 30_000, 'NX');
      if (acquired) {
        try {
          // Re-read: another worker may have refreshed while we waited.
          const row = await this.prisma.integrationCredential.findUniqueOrThrow({ where: { integrationId } });
          const current = this.crypto.decryptJson<CredentialBundle>({ ciphertext: row.ciphertext, keyVersion: row.keyVersion }, integrationId);
          if (row.expiresAt && row.expiresAt.getTime() - Date.now() >= REFRESH_SKEW_MS) return current;
          const refreshToken = 'refreshToken' in current ? current.refreshToken : undefined;
          if (!refreshToken) return current;
          const clientConfig = this.clientConfigFor(provider);
          const tokens = await refreshAccessToken(provider, { config: clientConfig, refreshToken }, this.oauthEndpoints());
          const next = { ...current, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken } as CredentialBundle;
          await this.store(integrationId, next, tokens.expiresAt ?? null);
          this.logger.log({ integrationId, provider }, 'Refreshed OAuth access token');
          return next;
        } catch (err) {
          await this.prisma.integration.update({ where: { id: integrationId }, data: { status: 'EXPIRED', healthStatus: 'UNHEALTHY', healthMessage: `Token refresh failed: ${(err as Error).message}` } });
          throw new ToolError('auth', `${provider} token refresh failed — reconnect the integration`, { retryable: false, cause: err });
        } finally {
          await this.redis.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token);
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return bundle;
  }

  clientConfigFor(provider: IntegrationProvider): { clientId: string; clientSecret: string } {
    const map: Partial<Record<IntegrationProvider, { clientId?: string; clientSecret?: string }>> = {
      GITHUB: this.config.oauth.github,
      GITHUB_ACTIONS: this.config.oauth.github,
      JIRA: this.config.oauth.jira,
      NOTION: this.config.oauth.notion,
    };
    const c = map[provider];
    if (!c?.clientId || !c.clientSecret) throw new ToolError('not_configured', `OAuth is not configured for ${provider}`, { retryable: false });
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  }
}
