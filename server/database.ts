import { PrismaClient } from '@prisma/client';
import { logger } from './utils/logger.js';
import { isPublishedApp } from './utils/env.js';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  },
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

export async function initializeDatabase(): Promise<void> {
  try {
    // Test the connection
    await prisma.$connect();
    logger.info('Database connected successfully');

    const [lunaUsers, solUsers] = await prisma.$transaction([
      prisma.userSettings.updateMany({
        where: { openaiModel: { in: ['gpt-5-mini', 'gpt-5.6-luna'] } },
        data: { openaiModel: 'gpt-6-luna' }
      }),
      prisma.userSettings.updateMany({
        where: { openaiModel: { in: ['gpt-5.4', 'gpt-5.6-sol'] } },
        data: { openaiModel: 'gpt-6-sol' }
      })
    ]);

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "user_settings" ALTER COLUMN "openai_model" SET DEFAULT 'gpt-6-luna'`
    );

    logger.info('OpenAI model configuration synchronized', {
      migratedToLuna: lunaUsers.count,
      migratedToSol: solUsers.count,
      defaultModel: 'gpt-6-luna'
    });

    // Run any pending migrations in development
    if (!isPublishedApp()) {
      // This would be handled by deployment in production  
      logger.info('Database is ready (development workspace)');
    } else {
      logger.info('Database is ready (published app)');
    }
  } catch (error) {
    logger.error('Failed to connect to database', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
