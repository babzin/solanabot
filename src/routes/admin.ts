import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { runWalletDiscovery } from '../cron/walletDiscovery.js';
import { swapQueue } from '../services/queue.js';
import { redis, REDIS_KEYS } from '../services/redis.js';
import { RiskTier } from '../types/index.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Authentication hook for all /api/admin routes
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers['x-admin-key'] as string;
    if (authHeader !== env.ADMIN_SECRET_KEY) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid admin secret key' });
    }
  });

  /**
   * Trigger on-demand wallet discovery & scoring
   */
  fastify.post('/api/admin/discover', async (request: FastifyRequest<{ Querystring: { tier?: string } }>, reply: FastifyReply) => {
    const tierQuery = request.query.tier?.toUpperCase();
    let filterTier: RiskTier | undefined;
    if (tierQuery === 'SAFE') filterTier = RiskTier.SAFE;
    if (tierQuery === 'RISK') filterTier = RiskTier.RISK;

    // Run discovery in background and respond
    runWalletDiscovery(filterTier)
      .then((wallets) => console.log(`Admin discovery run finished with ${wallets.length} wallets.`))
      .catch((err) => console.error('Admin discovery error:', err));

    return reply.send({
      message: 'On-demand wallet discovery job initiated successfully.',
      filterTier: filterTier || 'ALL',
    });
  });

  /**
   * View active tracked wallets and counts
   */
  fastify.get('/api/admin/wallets', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [allWallets, safeWallets, riskWallets] = await Promise.all([
      redis.smembers(REDIS_KEYS.WALLETS_ALL),
      redis.smembers(REDIS_KEYS.WALLETS_SAFE),
      redis.smembers(REDIS_KEYS.WALLETS_RISK),
    ]);

    return reply.send({
      totalActive: allWallets.length,
      safeCount: safeWallets.length,
      riskCount: riskWallets.length,
      safeWallets,
      riskWallets,
    });
  });

  /**
   * System health and queue status
   */
  fastify.get('/api/admin/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [waiting, active, failed, completed] = await Promise.all([
      swapQueue.getWaitingCount(),
      swapQueue.getActiveCount(),
      swapQueue.getFailedCount(),
      swapQueue.getCompletedCount(),
    ]);

    return reply.send({
      status: 'healthy',
      uptime: process.uptime(),
      redisConnected: redis.status === 'ready',
      queue: {
        waiting,
        active,
        failed,
        completed,
      },
    });
  });

  /**
   * View recent trade logs from database
   */
  fastify.get('/api/admin/trades', async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
    const limit = Math.min(100, parseInt(request.query.limit || '25', 10));
    try {
      const { prisma } = await import('../services/db.js');
      const trades = await prisma.tradeLog.findMany({
        take: limit,
        orderBy: { executedAt: 'desc' },
      });
      return reply.send({ count: trades.length, trades });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to retrieve trade logs from database', details: err.message });
    }
  });
}
