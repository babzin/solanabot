import axios from 'axios';
import { env } from '../config/env.js';
import { prisma } from './db.js';
import { checkActivePositionsTpSl } from './sniper.js';
import {
  bot,
  dispatchPriceDipMilestoneAlert,
  dispatchPricePumpMilestoneAlert,
  PriceDipMilestoneData,
  PricePumpMilestoneData,
} from './telegram.js';

let priceTrackerTimer: NodeJS.Timeout | null = null;

/**
 * Evaluates active tokens against 50% milestone pump and dip thresholds
 * Queries DexScreener free batch API (0 Helius credits consumed)
 */
export async function checkPriceMilestones(): Promise<number> {
  // 1. Fetch active tokens being tracked from PostgreSQL
  const activeTokens = await prisma.earlyTrendingToken.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    take: 60, // Track up to the last 60 tokens (past 3 days of alerts)
  });

  if (activeTokens.length === 0) {
    return 0;
  }

  const mints = activeTokens.map((t) => t.tokenMint);
  let alertsDispatched = 0;

  // 2. Query DexScreener in parallel chunks of 30
  const chunkArrays: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) {
    chunkArrays.push(mints.slice(i, i + 30));
  }

  const chunkResponses = await Promise.allSettled(
    chunkArrays.map((chunk) =>
      axios.get<any>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SolanaCopyBot/1.0)' },
      })
    )
  );

  // Map mint -> best Solana pair
  const bestPairs = new Map<string, any>();
  for (const res of chunkResponses) {
    if (res.status !== 'fulfilled' || !res.value.data?.pairs || !Array.isArray(res.value.data.pairs)) continue;
    for (const pair of res.value.data.pairs) {
      if (pair.chainId !== 'solana') continue;
      const baseAddr = pair.baseToken?.address;
      if (!baseAddr) continue;

      const currentBest = bestPairs.get(baseAddr);
      if (!currentBest || (pair.liquidity?.usd || 0) > (currentBest.liquidity?.usd || 0)) {
        bestPairs.set(baseAddr, pair);
      }
    }
  }

  // 3. Compare with entry prices and previous milestones
  for (const token of activeTokens) {
    try {
      const pair = bestPairs.get(token.tokenMint);
      if (!pair) continue;

        const currentPriceUsd = parseFloat(pair.priceUsd || '0');
        if (currentPriceUsd <= 0 || token.entryPriceUsd <= 0) continue;

        const currentMarketCap = pair.marketCap || pair.fdv || 0;
        const dexUrl = pair.url || (pair.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : ((token as any).dexUrl || `https://dexscreener.com/solana/${token.tokenMint}`));

        // Track peak and trough
        const newPeak = Math.max(token.peakPriceUsd, currentPriceUsd);
        const newLowest = Math.min(token.lowestPriceUsd, currentPriceUsd);

        // Check autonomous Take-Profit (2X) and Stop-Loss on active sniped positions
        try {
          const tpsl = await checkActivePositionsTpSl(token.tokenMint, currentPriceUsd);
          if (tpsl && env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
            await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpsl.message, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            });
          }
        } catch (tpslErr: any) {
          console.warn('⚠️ TP/SL check error:', tpslErr.message);
        }

        // --- CHECK A: +50% PUMP MILESTONES (+50%, +100%, +150%, +200%, +250%...) ---
        const gainPct = ((currentPriceUsd - token.entryPriceUsd) / token.entryPriceUsd) * 100;
        const pumpMilestoneStep = Math.floor(gainPct / 50) * 50;

        if (pumpMilestoneStep >= 50 && pumpMilestoneStep > token.lastMilestonePct) {
          const multiplier = Number((currentPriceUsd / token.entryPriceUsd).toFixed(2));
          const elapsedSec = Math.max(1, Math.floor((Date.now() - token.createdAt.getTime()) / 1000));
          const elapsedText =
            elapsedSec < 3600
              ? `${Math.floor(elapsedSec / 60)}m`
              : `${(elapsedSec / 3600).toFixed(1)}h`;

          const pumpData: PricePumpMilestoneData = {
            tokenMint: token.tokenMint,
            tokenSymbol: token.tokenSymbol,
            tokenName: token.tokenName,
            entryPriceUsd: token.entryPriceUsd,
            currentPriceUsd,
            entryMarketCap: token.entryMarketCap,
            currentMarketCap,
            gainPercent: Number(gainPct.toFixed(1)),
            milestonePercent: pumpMilestoneStep,
            multiplier,
            elapsedTimeText: elapsedText,
            dexUrl,
          };

          console.log(`🚀 [MILESTONE ALERT] $${token.tokenSymbol} reached +${pumpMilestoneStep}% (${multiplier}x)!`);
          await dispatchPricePumpMilestoneAlert(pumpData);
          alertsDispatched++;

          // Update database state
          await prisma.earlyTrendingToken.update({
            where: { id: token.id },
            data: {
              lastMilestonePct: pumpMilestoneStep,
              lastAlertedPriceUsd: currentPriceUsd,
              peakPriceUsd: newPeak,
              lowestPriceUsd: newLowest,
              dexUrl: dexUrl,
              pairAddress: pair.pairAddress || token.pairAddress,
            },
          });
          continue; // Processed pump
        }

        // --- CHECK B: -50% DIP MILESTONES (Drop from entry or 50% retracement from peak) ---
        // 1. Drop from initial entry (-50%)
        const dropFromEntryPct = ((currentPriceUsd - token.entryPriceUsd) / token.entryPriceUsd) * 100;
        // 2. Drop from peak (-50% pullback)
        const dropFromPeakPct = token.peakPriceUsd > 0 ? ((currentPriceUsd - token.peakPriceUsd) / token.peakPriceUsd) * 100 : 0;

        const isSignificantDipFromEntry = dropFromEntryPct <= -50 && token.lastDipMilestonePct > -50;
        const isSignificantRetraceFromPeak =
          token.peakPriceUsd >= token.entryPriceUsd * 1.5 && // Only if it had pumped at least 50% first
          dropFromPeakPct <= -50 &&
          token.lastDipMilestonePct !== -999; // Sentinel to prevent duplicate peak retrace alerts

        if (isSignificantDipFromEntry || isSignificantRetraceFromPeak) {
          const refPrice = isSignificantRetraceFromPeak ? token.peakPriceUsd : token.entryPriceUsd;
          const dropPct = isSignificantRetraceFromPeak ? dropFromPeakPct : dropFromEntryPct;
          const dipLabel = isSignificantRetraceFromPeak ? 'Peak Pullback' : 'Entry Drop';

          const refMc = isSignificantRetraceFromPeak
            ? (token.entryMarketCap && token.entryPriceUsd && token.entryPriceUsd > 0
                ? (token.peakPriceUsd / token.entryPriceUsd) * token.entryMarketCap
                : currentMarketCap * 2)
            : token.entryMarketCap;

          const dipData: PriceDipMilestoneData = {
            tokenMint: token.tokenMint,
            tokenSymbol: token.tokenSymbol,
            tokenName: token.tokenName,
            referencePriceUsd: refPrice,
            currentPriceUsd,
            currentMarketCap,
            referenceMarketCap: refMc,
            dropPercent: Number(Math.abs(dropPct).toFixed(1)),
            dipType: dipLabel,
            dexUrl,
          };

          console.log(`⚠️ [DIP ALERT] $${token.tokenSymbol} dropped -50% (${dipLabel})!`);
          await dispatchPriceDipMilestoneAlert(dipData);
          alertsDispatched++;

          await prisma.earlyTrendingToken.update({
            where: { id: token.id },
            data: {
              lastDipMilestonePct: isSignificantRetraceFromPeak ? -999 : -50,
              lastAlertedPriceUsd: currentPriceUsd,
              peakPriceUsd: newPeak,
              lowestPriceUsd: newLowest,
              dexUrl: dexUrl,
              pairAddress: pair.pairAddress || token.pairAddress,
            },
          });
        } else {
          // Just update peak/lowest or backfill dexUrl if changed
          if (newPeak !== token.peakPriceUsd || newLowest !== token.lowestPriceUsd || (!token.dexUrl && dexUrl)) {
            await prisma.earlyTrendingToken.update({
              where: { id: token.id },
              data: {
                peakPriceUsd: newPeak,
                lowestPriceUsd: newLowest,
                dexUrl: dexUrl,
                pairAddress: pair.pairAddress || token.pairAddress,
              },
            });
          }
        }
      } catch (tokenErr: any) {
        console.warn(`⚠️ Token price comparison error for ${token.tokenSymbol}:`, tokenErr.message);
      }
    }

  return alertsDispatched;
}

/**
 * Initializes the background price milestone checker
 * Runs every 12 seconds for instant pump/dip notifications (completely free DexScreener batch endpoint, 0 Helius credits)
 */
export function initPriceMilestoneTracker(): void {
  if (priceTrackerTimer) return;

  console.log('📈 Price Milestone Tracker: Online (High-Speed Engine checking every 12s)');

  // Run initial check after 2 seconds
  setTimeout(() => {
    checkPriceMilestones().catch((err) => console.warn('⚠️ Price milestone initial check error:', err.message));
  }, 2_000);

  // Interval every 12 seconds
  priceTrackerTimer = setInterval(() => {
    checkPriceMilestones().catch((err) => console.warn('⚠️ Price milestone cycle error:', err.message));
  }, 12 * 1000);
}
