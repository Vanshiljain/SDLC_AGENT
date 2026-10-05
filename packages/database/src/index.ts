import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';

export interface CreatePrismaClientOptions {
  url?: string;
  log?: Prisma.LogLevel[];
}

/** Factory so apps control connection URL and logging. */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    log: options.log ?? ['warn', 'error'],
  });
}

/** Postgres unique-violation helper (Prisma P2002). */
export function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Record not found for update/delete (Prisma P2025). */
export function isRecordNotFound(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}
