import { Prisma } from '@forgeline/database';

/** Convert a value for a nullable JSON column (Prisma requires DbNull instead of null). */
export function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
