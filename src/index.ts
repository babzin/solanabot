import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { runWalletDiscovery } from './cron/walletDiscovery.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhook.js';
import { prisma } from './services/db.js';
import { initSwapWorker } from './services/queue.js';
import { redis, syncWalletsToRedis } from './services/redis.js';
import { initTelegramCommands } from './services/telegram.js';
import { RiskTier, StrategyProfile } from './types/index.js';

const server = Fastify({
  logger: {
    level: env.NODE_ENV === 'development' ? 'info' : 'warn',
    transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

/**
 * Hydrates Redis active wallet sets from PostgreSQL on startup
 * Protects Helius API credits by avoiding redundant re-discovery after restarts
 */
async function hydrateWalletsFromDb(): Promise<void> {
  try {
    const activeWallets = await prisma.trackedWallet.findMany({
      where: { isActive: true },
      take: env.MAX_TRACKED_WALLETS,
    });

    if (activeWallets.length > 0) {
      console.log(`💾 Hydrating ${activeWallets.length} active wallets from PostgreSQL to Redis...`);
      await syncWalletsToRedis(
        activeWallets.map((w) => ({
          address: w.address,
          label: w.label || undefined,
          tier: w.tier as RiskTier,
          strategyProfile: w.strategyProfile as StrategyProfile,
          winRate: w.winRate,
          profitFactor: w.profitFactor,
          totalTrades: w.totalTrades,
          medianHoldSeconds: w.medianHoldSeconds,
          netSolProfit: w.netSolProfit,
        }))
      );
    } else {
      console.log('ℹ️ No active wallets found in database yet. Ready for first discovery run.');
    }
  } catch (err: any) {
    console.warn('⚠️ Could not hydrate wallets from DB on startup (database may need migration):', err.message);
  }
}

async function main() {
  // 1. Register Fastify plugins
  await server.register(cors, { origin: '*' });
  await server.register(sensible);

  // 2. Register Routes
  await server.register(webhookRoutes);
  await server.register(adminRoutes);

  // Root health ping
  server.get('/', async () => {
    return {
      service: 'Solana Copy Trading Intelligence Bot',
      version: '1.0.0',
      status: 'operational',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    };
  });

  // 3. Hydrate state from PostgreSQL
  await hydrateWalletsFromDb();

  // 4. Initialize background worker & Telegram command listeners
  console.log('⚡ Initializing BullMQ trade processing worker...');
  const worker = initSwapWorker();
  initTelegramCommands();

  // 5. Setup scheduled wallet discovery (runs every DISCOVERY_INTERVAL_HOURS to preserve API quotas)
  const intervalMs = env.DISCOVERY_INTERVAL_HOURS * 60 * 60 * 1000;
  console.log(`⏰ Scheduled quant discovery initialized: runs every ${env.DISCOVERY_INTERVAL_HOURS} hour(s).`);
  const discoveryTimer = setInterval(() => {
    console.log('⏰ Executing scheduled smart-money quant discovery cycle...');
    runWalletDiscovery().catch((err) => console.error('Scheduled discovery error:', err.message));
  }, intervalMs);

  // 6. Start HTTP Server
  try {
    await server.listen({ port: env.PORT, host: '0.0.0.0' });
    console.log(`🚀 Solana Copy Trading Server running at http://localhost:${env.PORT}`);
    console.log(`📡 Ingestion endpoint ready at POST /api/webhook/swaps`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // 7. Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Gracefully shutting down server, workers, and database connections...');
    clearInterval(discoveryTimer);
    await worker.close();
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
