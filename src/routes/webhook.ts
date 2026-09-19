import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { parseHeliusSwapTransaction } from '../services/helius.js';
import { swapQueue } from '../services/queue.js';
import { getWalletMetadata, isDuplicateSignature } from '../services/redis.js';
import { HeliusParsedTransaction } from '../types/index.js';

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Fast-Path Helius Enhanced Webhook Ingestion
   * Responds immediately with 200 OK to prevent Helius delivery timeouts
   */
  fastify.post('/api/webhook/swaps', async (request: FastifyRequest<{ Querystring: { auth?: string } }>, reply: FastifyReply) => {
    // 1. Authenticate webhook request if WEBHOOK_AUTH_TOKEN is configured
    if (env.WEBHOOK_AUTH_TOKEN) {
      const authHeader = request.headers.authorization || (request.headers['x-api-key'] as string);
      const queryAuth = request.query?.auth;
      const expected = env.WEBHOOK_AUTH_TOKEN;

      const isAuthorized =
        authHeader === expected ||
        authHeader === `Bearer ${expected}` ||
        queryAuth === expected;

      if (!isAuthorized) {
        console.warn('🛑 Unauthorized webhook delivery attempt rejected.');
        return reply.code(401).send({ error: 'Unauthorized: Invalid webhook auth token' });
      }
    }

    // 2. Acknowledge receipt to Helius immediately
    reply.code(200).send({ status: 'acknowledged' });

    try {
      const transactions = request.body as HeliusParsedTransaction[];
      if (!Array.isArray(transactions) || transactions.length === 0) {
        return;
      }

      for (const tx of transactions) {
        // 3. Dedup by transaction signature in Redis
        const isDupe = await isDuplicateSignature(tx.signature);
        if (isDupe) {
          continue;
        }

        // 4. Parse swap transaction & identify matching tracked wallet
        const swap = await parseHeliusSwapTransaction(tx);
        if (!swap) {
          continue;
        }

        // Loop-prevention: Never copy trade your own wallet
        if (env.USER_SOLANA_WALLET && swap.walletAddress === env.USER_SOLANA_WALLET) {
          continue;
        }

        // 5. Retrieve wallet score & strategy profile metadata from Redis
        const walletMeta = await getWalletMetadata(swap.walletAddress);
        if (!walletMeta) {
          continue;
        }

        // 6. Enqueue job for asynchronous rate-limited verification & dispatch
        await swapQueue.add(`swap-${swap.signature.slice(0, 12)}`, {
          swap,
          wallet: walletMeta,
        });

        console.log(`📥 Enqueued swap from ${swap.walletAddress.slice(0, 6)} on mint ${swap.tokenMint}`);
      }
    } catch (err: any) {
      console.error('⚠️ Error processing webhook payload:', err.message);
    }
  });
}
