import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

declare global {
  // Allow global prisma instance in development to avoid exhausting connections on hot-reload
  // eslint-disable-next-line no-var
  var __globalPrisma__: PrismaClient | undefined;
}

export const prisma =
  globalThis.__globalPrisma__ ||
  new PrismaClient({
    log: [],
    errorFormat: 'minimal',
  });

globalThis.__globalPrisma__ = prisma;

