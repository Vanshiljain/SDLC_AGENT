import 'reflect-metadata';
import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { BRAND } from '@forgeline/shared';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';

export function configureHttpApp(app: NestExpressApplication, config = loadConfig()): void {
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Organization-Id', 'X-Request-Id', 'X-CSRF-Token', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.useBodyParser('json', { limit: '5mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: false }));
  app.enableShutdownHooks();
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  if (config.role === 'worker') {
    // Workers run queue processors and schedulers without an HTTP server.
    const ctx = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    ctx.useLogger(ctx.get(Logger));
    ctx.enableShutdownHooks();
    new NestLogger('Bootstrap').log(`${BRAND.name} worker started`);
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  configureHttpApp(app, config);

  if (!config.isProduction || process.env.SWAGGER_ENABLED === 'true') {
    const doc = new DocumentBuilder()
      .setTitle(`${BRAND.name} API`)
      .setDescription(`${BRAND.tagline}. REST API for projects, flows, runs, approvals, integrations, agents and knowledge.`)
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Organization-Id' }, 'organization')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/openapi.json' });
  }

  await app.listen(config.port, '0.0.0.0');
  new NestLogger('Bootstrap').log(`${BRAND.name} API (${config.role}) listening on :${config.port}`);
}

if (require.main === module) {
  bootstrap().catch((err: unknown) => {
    console.error('Fatal bootstrap error', err);
    process.exit(1);
  });
}
