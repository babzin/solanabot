import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { STRATEGY_DEFINITIONS } from '../config/strategies.js';
import { RiskTier, ScoredWallet, SwapEvent, TradeAlert } from '../types/index.js';
import { prisma } from './db.js';
import { getMarketData } from './market.js';
import { redis } from './redis.js';
import { verifyTokenSecurity } from './security.js';
import { dispatchExitAlert, dispatchSnipeNotification, dispatchSnipeSellNotification, dispatchTradeAlert } from './telegram.js';
import { executeSnipeTrade, executeSnipeSell, getUserAutoSnipeConfig } from './sniper.js';

export interface SwapJobData {
  swap: SwapEvent;
  wallet: ScoredWallet;
}

export const SWAP_QUEUE_NAME = 'solana-swap-processing-queue';

export const swapQueue = new Queue<SwapJobData>(SWAP_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

async function logTradeSafely(
  swap: SwapEvent,
  wallet: ScoredWallet,
  status: 'ALERTED' | 'SNIPED' | 'SKIPPED_SECURITY' | 'SKIPPED_IMPACT' | 'ERROR',
  entryMarketCap?: number,
  rejectionReason?: string
) {
  try {
    // Ensure parent TrackedWallet exists in Postgres
    await prisma.trackedWallet.upsert({
      where: { address: wallet.address },
      update: {
        label: wallet.label,
      },
      create: {
        address: wallet.address,
        label: wallet.label,
        tier: wallet.tier,
        strategyProfile: wallet.strategyProfile,
        winRate: wallet.winRate,
        profitFactor: wallet.profitFactor,
        totalTrades: wallet.totalTrades,
        medianHoldSeconds: wallet.medianHoldSeconds,
        netSolProfit: wallet.netSolProfit,
        isActive: true,
      },
    });

    await prisma.tradeLog.upsert({
      where: { signature: swap.signature },
      update: { status, rejectionReason },
      create: {
        signature: swap.signature,
        walletAddress: wallet.address,
        tokenMint: swap.tokenMint,
        tokenSymbol: swap.tokenSymbol,
        side: swap.side,
        solAmount: swap.solAmount,
        tokenAmount: swap.tokenAmount,
        entryMarketCap,
        status,
        rejectionReason,
        executedAt: new Date(swap.timestamp * 1000),
      },
    });
  } catch (err: any) {
    // Database logging failure should be noted but not crash the alert pipeline
    console.warn(`⚠️ Failed to persist TradeLog in DB for ${swap.signature.slice(0, 10)}:`, err.message);
  }
}

/**
 * BullMQ Worker processing trade events asynchronously with rate limiting
 */
export function initSwapWorker(): Worker<SwapJobData> {
  const worker = new Worker<SwapJobData>(
    SWAP_QUEUE_NAME,
    async (job) => {
      const { swap, wallet } = job.data;
      console.log(`⚙️ Processing swap job [${job.id}] for wallet ${wallet.address.slice(0, 6)}...`);

      // 1. Handle SELL swaps (Exit warning & Autonomous Auto-Sell)
      if (swap.side === 'SELL') {
        const soldPct = swap.soldPercent ?? 100;
        console.log(`📉 Sell event detected on ${swap.tokenMint} by ${wallet.address} (~${soldPct}%)`);

        // Check if user has AI Auto-Trade enabled
        const userPref = await getUserAutoSnipeConfig(env.TELEGRAM_CHAT_ID);
        if (env.AUTO_SNIPE_ENABLED || userPref.autoSnipeEnabled) {
          try {
            const sellResult = await executeSnipeSell(
              swap.tokenMint,
              swap.tokenSymbol,
              undefined
            );
            if (sellResult.success) {
              await dispatchSnipeSellNotification(sellResult);
            }
          } catch (sellErr: any) {
            console.warn('⚠️ Auto-sell execution error:', sellErr.message);
          }
        }

        await Promise.all([
          dispatchExitAlert(wallet.address, swap.tokenMint, soldPct, wallet.tier, swap.tokenSymbol, wallet.label),
          logTradeSafely(swap, wallet, 'ALERTED'),
        ]);
        return;
      }

      // 2. Handle BUY swaps
      // Parallel fast-path verification
      const [securityResult, marketData] = await Promise.all([
        verifyTokenSecurity(swap.tokenMint, swap.programId),
        getMarketData(swap.tokenMint, swap.solAmount, swap.programId, swap.tokenAmount),
      ]);

      // A. Contract Security Gate
      if (!securityResult.passed) {
        console.warn(`🛑 Trade rejected by Security Gate for ${swap.tokenMint}:`, securityResult.reasons);
        await logTradeSafely(swap, wallet, 'SKIPPED_SECURITY', undefined, securityResult.reasons.join('; '));
        return;
      }

      // B. Market & Price Impact Gate
      if (!marketData) {
        console.warn(`⚠️ Could not retrieve market data for ${swap.tokenMint}. Dropping alert.`);
        await logTradeSafely(swap, wallet, 'SKIPPED_IMPACT', undefined, 'Market data lookup failed');
        return;
      }

      // Price impact check (reject if swap spiked price > 3%)
      if (marketData.priceImpactPercent > env.PRICE_IMPACT_MAX_PERCENT) {
        console.warn(
          `🛑 High Price Impact (${marketData.priceImpactPercent}% > ${env.PRICE_IMPACT_MAX_PERCENT}%). Dropping alert.`
        );
        await logTradeSafely(
          swap,
          wallet,
          'SKIPPED_IMPACT',
          marketData.marketCap,
          `High Price Impact: ${marketData.priceImpactPercent}%`
        );
        return;
      }

      // Liquidity reserve check for Raydium / non-bonding curve tokens
      if (!marketData.isBondingCurve && marketData.poolReserveSol < env.MIN_POOL_RESERVE_SOL) {
        console.warn(
          `🛑 Low Liquidity Pool (${marketData.poolReserveSol} SOL < ${env.MIN_POOL_RESERVE_SOL} SOL). Dropping alert.`
        );
        await logTradeSafely(
          swap,
          wallet,
          'SKIPPED_IMPACT',
          marketData.marketCap,
          `Low Pool Reserve: ${marketData.poolReserveSol} SOL`
        );
        return;
      }

      // C. Sizing / Profile bounds check
      const strategy = STRATEGY_DEFINITIONS[wallet.strategyProfile];
      if (strategy && strategy.maxSwapSol && swap.solAmount > strategy.maxSwapSol) {
        console.warn(`⚠️ Swap size ${swap.solAmount} SOL exceeded strategy max ${strategy.maxSwapSol} SOL.`);
      }

      // Merge deep security & holder analytics into market data
      if (securityResult.analytics && marketData.analytics) {
        marketData.analytics = {
          ...marketData.analytics,
          ...securityResult.analytics,
          chartUrl: marketData.analytics.chartUrl || marketData.dexUrl,
        };
      }

      // Execute auto-snipe if enabled globally or enabled by user
      let tradeStatus: 'ALERTED' | 'SNIPED' = 'ALERTED';
      const userPref = await getUserAutoSnipeConfig(env.TELEGRAM_CHAT_ID);
      if (env.AUTO_SNIPE_ENABLED || userPref.autoSnipeEnabled) {
        try {
          const snipeAmount = userPref.autoSnipeSolAmount || env.AUTO_SNIPE_DEFAULT_SOL || 0.01;
          const snipeResult = await executeSnipeTrade(
            swap.tokenMint,
            snipeAmount,
            marketData.tokenSymbol || swap.tokenSymbol,
            marketData.priceUsd
          );
          if (snipeResult.success) {
            tradeStatus = 'SNIPED';
            await dispatchSnipeNotification(snipeResult);
          }
        } catch (snipeErr: any) {
          console.warn('⚠️ Auto-snipe execution error:', snipeErr.message);
        }
      }

      // Construct and dispatch alert
      const alert: TradeAlert = {
        signature: swap.signature,
        wallet,
        swap,
        market: marketData,
        security: securityResult,
        timestamp: Date.now(),
      };

      await Promise.all([
        dispatchTradeAlert(alert),
        logTradeSafely(swap, wallet, tradeStatus, marketData.marketCap),
      ]);
    },
    {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000, // Max 10 jobs per second (protects Telegram rate limit)
      },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`❌ Worker job ${job?.id} failed:`, err.message);
  });

  return worker;
}
