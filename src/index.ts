import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { adminRoutes } from './routes/admin.js';
import { terminalRoutes } from './routes/terminal.js';
import { prisma } from './services/db.js';
import { initEarlyTrendingCron } from './services/earlyTrending.js';
import { initPriceMilestoneTracker } from './services/priceTracker.js';
import { redis } from './services/redis.js';
import { bot, initTelegramCommands } from './services/telegram.js';

const server = Fastify({
  logger: {
    level: env.NODE_ENV === 'development' ? 'info' : 'warn',
    transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

async function main() {
  console.log('====================================================');
  console.log('👻 SOUL TERMINAL & SOLANA EARLY TRENDING ENGINE');
  console.log('   Replicating @solearlytrending & soulterminal.ai');
  console.log('====================================================');

  // 1. Register Fastify plugins
  await server.register(cors, { origin: '*' });
  await server.register(sensible);

  // 2. Register Routes (Web Terminal & APIs)
  await server.register(terminalRoutes);
  await server.register(adminRoutes);

  // 3. Initialize Early Trending Discovery Engine (35s cycle)
  initEarlyTrendingCron();

  // 4. Initialize Price Milestone Tracker (+50% to 79X pumps & -50% retracements)
  initPriceMilestoneTracker();

  // 5. Initialize Telegram Command Handlers & Polling
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const me = await bot.getMe();
      console.log(`✅ Telegram Bot Online as @${me.username} (${me.first_name})`);
    } catch (err: any) {
      console.warn('⚠️ Telegram getMe notice:', err.message);
    }
  }
  initTelegramCommands();

  // 6. Start HTTP Web Server
  try {
    await server.listen({ port: env.PORT, host: '0.0.0.0' });
    console.log(`🚀 Soul Web Terminal running at: http://localhost:${env.PORT}`);
    console.log(`📡 Early Radar Live Feed available at: http://localhost:${env.PORT}/api/trending`);
    console.log(`⚡ Real-Time SSE Stream active at: http://localhost:${env.PORT}/api/events`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // 7. Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Gracefully shutting down Soul Terminal server and database...');
    await server.close();
    redis.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
