import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from './prisma/prisma.service';
import { EncryptionService, SECRETS_PROVIDER, secretsProviderFactory } from './crypto/encryption.service';
import { RedisService } from './redis/redis.provider';
import { ERROR_REPORTER, LoggingErrorReporter } from './errors';

@Global()
@Module({
  providers: [
    PrismaService,
    RedisService,
    EncryptionService,
    { provide: SECRETS_PROVIDER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => secretsProviderFactory(c) },
    { provide: ERROR_REPORTER, useClass: LoggingErrorReporter },
  ],
  exports: [PrismaService, RedisService, EncryptionService, SECRETS_PROVIDER, ERROR_REPORTER],
})
export class CommonModule {}
