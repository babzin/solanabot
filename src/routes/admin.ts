import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from '../services/db.js';
import { runEarlyTrendingRadarCycle } from '../services/earlyTrending.js';
import { checkPriceMilestones } from '../services/priceTracker.js';
import { redis } from '../services/redis.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Authentication hook for all /api/admin routes
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers['x-admin-key'] as string;
    if (authHeader !== env.ADMIN_SECRET_KEY) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid admin secret key' });
    }
  });

  /**
   * Trigger on-demand Early Trending Radar Cycle
   */
  fastify.post('/api/admin/scan', async (_req: FastifyRequest, reply: FastifyReply) => {
    runEarlyTrendingRadarCycle()
      .then((count) => console.log(`[Admin Trigger] Scan finished. ${count} new alerts dispatched.`))
      .catch((err) => console.error('[Admin Trigger Error]:', err));

    return reply.send({
      message: 'On-demand Early Trending Radar scan cycle initiated successfully.',
    });
  });

  /**
   * Trigger on-demand Price Milestone Evaluation (+50% / -50%)
   */
  fastify.post('/api/admin/check-milestones', async (_req: FastifyRequest, reply: FastifyReply) => {
    checkPriceMilestones()
      .then((count) => console.log(`[Admin Trigger] Milestone check finished. ${count} alerts sent.`))
      .catch((err) => console.error('[Admin Trigger Error]:', err));

    return reply.send({
      message: 'On-demand Price Milestone evaluation initiated successfully.',
    });
  });

  /**
   * Ingest a trending signal message or token from @solearlytrending
   */
  fastify.post('/api/admin/ingest-signal', async (req: FastifyRequest<{ Body: { text?: string; mint?: string } }>, reply: FastifyReply) => {
    const { text, mint } = (req.body as any) || {};
    const payload = text || mint;
    if (!payload) {
      return reply.code(400).send({ error: 'Missing text or mint in request body.' });
    }

    const { ingestTrendingSignal } = await import('../services/signalIngestor.js');
    const result = await ingestTrendingSignal(payload, { source: 'admin_api' });
    return reply.send(result);
  });

  /**
   * System health and database status
   */
  fastify.get('/api/admin/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const today = new Date().toISOString().slice(0, 10);
    const [totalTrendingTokens, todayAlertedCount] = await Promise.all([
      prisma.earlyTrendingToken.count(),
      prisma.earlyTrendingToken.count({ where: { alertDate: today } }),
    ]);

    return reply.send({
      status: 'healthy',
      system: 'Soul Terminal & Solana Early Trending Radar',
      uptime: process.uptime(),
      redisConnected: redis.status === 'ready',
      database: {
        totalTrendingTokens,
        todayAlertedCount,
      },
    });
  });
}
