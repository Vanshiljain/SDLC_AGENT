import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CredentialVault } from './credential-vault.service';
import { ConnectionResolver } from './connection-resolver.service';
import { IntegrationHealthScheduler } from './integration-health.scheduler';

@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, CredentialVault, ConnectionResolver, IntegrationHealthScheduler],
  exports: [IntegrationsService, CredentialVault, ConnectionResolver],
})
export class IntegrationsModule {}
