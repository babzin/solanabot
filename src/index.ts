import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { adminRoutes } from './routes/admin.js';
import { terminalRoutes } from './routes/terminal.js';
import { prisma } from './services/db.js';
import { initEarlyTrendingCron } from './services/earlyTrending.js';
import { initLossLearningEngine } from './services/lossLearner.js';
import { initPaperTradingEngine } from './services/paperTrading.js';
import { initPriceMilestoneTracker } from './services/priceTracker.js';
import { redis } from './services/redis.js';
import { bot, initTelegramCommands } from './services/telegram.js';
import { initWeeklyReportCron } from './services/weeklyCron.js';

// Process-level resilience guards to prevent background crashes on network drops or unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ [Process Guard] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
  console.error('🚨 [Process Guard] Uncaught Exception:', err, 'origin:', origin);
});

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

  // 1b. Lightweight Health & Keep-Alive Endpoints (for UptimeRobot & Render free-tier keep-alive)
  server.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'Solana Copy Trading & Breakout Bot',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  server.get('/ping', async (_req, reply) => {
    return reply.status(200).send('pong');
  });

  // 2. Register Routes (Web Terminal & APIs)
  await server.register(terminalRoutes);
  await server.register(adminRoutes);

  // 3. Initialize Adaptive Loss-Learning Feedback Engine (Pre-computes flop signatures & danger zones)
  await initLossLearningEngine();

  // 4. Initialize $1,000 Real-Market Paper Trading Engine
  await initPaperTradingEngine();

  // 5. Initialize Early Trending Discovery Engine (12s cycle)
  initEarlyTrendingCron();

  // 5. Initialize Price Milestone Tracker (+50% to 79X pumps & -50% retracements)
  initPriceMilestoneTracker();

  // 6. Initialize Weekly Performance Recap Scheduler (Sunday 23:55 UTC)
  initWeeklyReportCron();

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

    // Keep-Alive Engine: Pings public URL every 5 minutes to prevent Render Free tier from sleeping
    const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : undefined;
    const externalUrl = env.RENDER_EXTERNAL_URL || renderHostname || env.APP_BASE_URL;

    if (externalUrl && !externalUrl.includes('localhost')) {
      const pingTarget = `${externalUrl.replace(/\/$/, '')}/health`;
      console.log(`💓 [Keep-Alive Engine] Automated self-ping active for: ${pingTarget} (every 5 mins)`);
      setInterval(async () => {
        try {
          const { default: axios } = await import('axios');
          await axios.get(pingTarget, { timeout: 10000 });
          console.log(`💓 [Keep-Alive Engine] Ping delivered to ${pingTarget} at ${new Date().toISOString()}`);
        } catch (pingErr: any) {
          console.warn('⚠️ [Keep-Alive Engine] Ping warning:', pingErr?.message);
        }
      }, 5 * 60 * 1000);
    }
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
