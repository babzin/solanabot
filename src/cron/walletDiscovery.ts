import axios from 'axios';
import { env } from '../config/env.js';
import { generateWalletAlias } from '../config/strategies.js';
import { prisma } from '../services/db.js';
import { updateHeliusWebhookAddresses, WSOL_MINT } from '../services/helius.js';
import { syncWalletsToRedis } from '../services/redis.js';
import { RiskTier, ScoredWallet, StrategyProfile } from '../types/index.js';

interface DexProfileToken {
  url: string;
  chainId: string;
  tokenAddress: string;
  description?: string;
}

/**
 * 1. Fetch Trending Seed Tokens from DexScreener (100% Free API, no credits used)
 */
async function fetchTrendingSeeds(): Promise<string[]> {
  try {
    const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
    const res = await axios.get<DexProfileToken[]>(url, { timeout: 5000 });
    const solanaTokens = res.data
      .filter((t) => t.chainId === 'solana')
      .slice(0, 8)
      .map((t) => t.tokenAddress);

    console.log(`🌱 Discovered ${solanaTokens.length} trending Solana seed tokens from DexScreener.`);
    return solanaTokens;
  } catch (err: any) {
    console.warn('⚠️ DexScreener trending fetch failed, using curated seeds:', err.message);
    return [
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
      'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // GOAT
    ];
  }
}

/**
 * 2. Query Candidate Wallets for Seeds via Helius API (Preserves credit budget)
 */
async function fetchCandidatesForToken(tokenMint: string): Promise<string[]> {
  if (!env.HELIUS_API_KEY || env.HELIUS_API_KEY.includes('dummy')) {
    // Return sample high-performing test wallets for dry run
    return [
      '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      'H84KTaN41Kq9X3ZJ7yqUoE1WJ94Z1L3z5D2J1B8k3LmP',
      '3K87fR9kL1mJ5x8Q2Z4W6e7T9p0A1B2C3D4E5F6G7H8I',
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    ];
  }

  try {
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${env.HELIUS_API_KEY}&limit=20`;
    const res = await axios.get<any[]>(url, { timeout: 6000 });
    const buyers = new Set<string>();

    for (const tx of res.data) {
      if (tx.feePayer && !buyers.has(tx.feePayer)) {
        buyers.add(tx.feePayer);
      }
    }
    // Limit to top 4 buyers per seed to preserve API budget
    return Array.from(buyers).slice(0, 4);
  } catch (err: any) {
    console.warn(`⚠️ Could not fetch transactions for seed ${tokenMint}:`, err.message);
    return [];
  }
}

/**
 * Fetches transaction history for a candidate wallet with strict credit limiting
 */
async function fetchWalletTransactions(walletAddress: string): Promise<any[]> {
  if (!env.HELIUS_API_KEY || env.HELIUS_API_KEY.includes('dummy')) {
    return [];
  }

  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${env.HELIUS_API_KEY}&limit=25`;
    const res = await axios.get<any[]>(url, { timeout: 6000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err: any) {
    console.warn(`⚠️ Could not fetch transactions for wallet ${walletAddress.slice(0, 6)}:`, err.message);
    return [];
  }
}

interface TokenTradeAgg {
  spentSol: number;
  boughtTokens: number;
  receivedSol: number;
  soldTokens: number;
  buyTimestamps: number[];
  sellTimestamps: number[];
}

/**
 * 3. Quantitative Evaluation & Hard Elimination Gates (Anti-MEV & Anti-Luck)
 * Computes real win rate, profit factor, hold times, and PnL from historical transactions
 */
export function evaluateWalletQuantMetrics(address: string, transactions: any[]): ScoredWallet | null {
  if (!transactions || transactions.length === 0) {
    // If no transactions provided (e.g. testing or dry-run), require existing profile
    return null;
  }

  const tokenActivity: Record<string, TokenTradeAgg> = {};

  for (const tx of transactions) {
    if (!tx.accountData || !Array.isArray(tx.accountData)) continue;

    const userAcc = tx.accountData.find((a: any) => a.account === address);
    if (!userAcc) continue;

    // SOL & WSOL delta
    let nativeSolDelta = (userAcc.nativeBalanceChange || 0) / 1e9;
    let wsolDelta = 0;
    let targetMint = '';
    let targetTokenAmount = 0;

    if (userAcc.tokenBalanceChanges && Array.isArray(userAcc.tokenBalanceChanges)) {
      for (const tc of userAcc.tokenBalanceChanges) {
        const raw = parseFloat(tc.rawTokenAmount?.tokenAmount || '0');
        const decimals = tc.rawTokenAmount?.decimals || 6;
        const adjusted = raw / Math.pow(10, decimals);

        if (tc.mint === WSOL_MINT) {
          wsolDelta += adjusted;
        } else {
          targetMint = tc.mint;
          targetTokenAmount = Math.abs(adjusted);
        }
      }
    }

    const totalSolDelta = nativeSolDelta + wsolDelta;
    if (!targetMint || Math.abs(totalSolDelta) < 0.01) continue;

    if (!tokenActivity[targetMint]) {
      tokenActivity[targetMint] = {
        spentSol: 0,
        boughtTokens: 0,
        receivedSol: 0,
        soldTokens: 0,
        buyTimestamps: [],
        sellTimestamps: [],
      };
    }

    const agg = tokenActivity[targetMint];
    const ts = tx.timestamp || Math.floor(Date.now() / 1000);

    if (totalSolDelta < 0) {
      // Bought tokens
      agg.spentSol += Math.abs(totalSolDelta);
      agg.boughtTokens += targetTokenAmount;
      agg.buyTimestamps.push(ts);
    } else {
      // Sold tokens
      agg.receivedSol += totalSolDelta;
      agg.soldTokens += targetTokenAmount;
      agg.sellTimestamps.push(ts);
    }
  }

  // Analyze round trips
  let winCount = 0;
  let lossCount = 0;
  let grossProfitSol = 0;
  let grossLossSol = 0;
  const winningPnls: number[] = [];
  const holdDurations: number[] = [];

  for (const mint of Object.keys(tokenActivity)) {
    const agg = tokenActivity[mint];
    // Check if there was at least some exit or round-trip
    if (agg.receivedSol > 0 && agg.spentSol > 0) {
      const pnl = agg.receivedSol - agg.spentSol;
      if (pnl > 0) {
        winCount++;
        grossProfitSol += pnl;
        winningPnls.push(pnl);
      } else if (pnl < 0) {
        lossCount++;
        grossLossSol += Math.abs(pnl);
      }

      // Calculate hold duration in seconds
      if (agg.buyTimestamps.length > 0 && agg.sellTimestamps.length > 0) {
        const firstBuy = Math.min(...agg.buyTimestamps);
        const lastSell = Math.max(...agg.sellTimestamps);
        const holdSec = Math.max(1, lastSell - firstBuy);
        holdDurations.push(holdSec);
      }
    }
  }

  const closedTrades = winCount + lossCount;
  // If fewer than 2 closed token round-trips in the transaction window, cannot reliably score
  if (closedTrades < 2) {
    return null;
  }

  const winRate = Number((winCount / closedTrades).toFixed(2));
  const profitFactor = grossLossSol > 0
    ? Number((grossProfitSol / grossLossSol).toFixed(2))
    : grossProfitSol > 0 ? 5.0 : 0.0;
  const netSolProfit = Number((grossProfitSol - grossLossSol).toFixed(2));

  // Sort hold times to calculate median
  holdDurations.sort((a, b) => a - b);
  const medianHoldSeconds = holdDurations.length > 0
    ? holdDurations[Math.floor(holdDurations.length / 2)]
    : 600;

  // Calculate Anti-Luck percentage
  const maxSingleTokenProfit = winningPnls.length > 0 ? Math.max(...winningPnls) : 0;
  const maxSingleTokenProfitPct = grossProfitSol > 0
    ? maxSingleTokenProfit / grossProfitSol
    : 0;

  // HARD GATE 1: Anti-MEV Gate (Minimum median hold >= 3 minutes / 180s)
  if (medianHoldSeconds < 180) {
    console.log(`❌ Discarded ${address.slice(0, 6)}: Un-copyable MEV front-runner (Hold: ${medianHoldSeconds}s < 180s)`);
    return null;
  }

  // HARD GATE 2: Anti-Luck Gate (No more than 60% of total profits from a single token)
  if (winningPnls.length >= 2 && maxSingleTokenProfitPct > 0.60) {
    console.log(
      `❌ Discarded ${address.slice(0, 6)}: One-hit wonder (${(maxSingleTokenProfitPct * 100).toFixed(0)}% PnL from 1 coin)`
    );
    return null;
  }

  // HARD GATE 3: Must be net profitable or have >= 50% win rate
  if (netSolProfit <= 0 && winRate < 0.50) {
    return null;
  }

  // Strategy Categorization
  let profile = StrategyProfile.MIGRATION_CONSOLIDATOR;
  let tier = RiskTier.SAFE;

  if (winRate >= 0.65 && medianHoldSeconds < 1800) {
    profile = StrategyProfile.MULTI_DEX_SCALPER;
    tier = RiskTier.SAFE;
  } else if (medianHoldSeconds >= 7200 && profitFactor >= 2.0) {
    profile = StrategyProfile.SWING_WHALE;
    tier = RiskTier.SAFE;
  } else if (profitFactor >= 2.0 && winRate >= 0.55) {
    profile = StrategyProfile.MIGRATION_CONSOLIDATOR;
    tier = RiskTier.SAFE;
  } else if (winRate >= 0.60) {
    profile = StrategyProfile.DIP_ACCUMULATOR;
    tier = RiskTier.SAFE;
  } else {
    profile = StrategyProfile.BONDING_BREAKOUT_HUNTER;
    tier = RiskTier.RISK;
  }

  const label = generateWalletAlias(address, profile);

  return {
    address,
    label,
    tier,
    strategyProfile: profile,
    winRate,
    profitFactor,
    totalTrades: closedTrades,
    medianHoldSeconds,
    netSolProfit,
  };
}

/**
 * Main Discovery & Sync Workflow with Credit Optimization
 */
export async function runWalletDiscovery(filterTier?: RiskTier): Promise<ScoredWallet[]> {
  console.log('🔍 Starting Quantitative Smart-Money Discovery Engine...');
  const seeds = await fetchTrendingSeeds();
  const candidateSet = new Set<string>();

  // 1. Extract candidate wallets from seeds (top 5 seeds to protect free-tier limits)
  for (const seed of seeds.slice(0, 5)) {
    const wallets = await fetchCandidatesForToken(seed);
    wallets.forEach((w) => {
      if (!env.USER_SOLANA_WALLET || w !== env.USER_SOLANA_WALLET) {
        candidateSet.add(w);
      }
    });
  }

  console.log(`📊 Discovered ${candidateSet.size} candidate wallets. Checking database cache...`);
  const qualifiedWallets: ScoredWallet[] = [];
  const uncachedCandidates: string[] = [];

  // 2. Database Credit-Preservation Check: Reuse recently scored wallets (< 48 hours old)
  for (const addr of candidateSet) {
    try {
      const existing = await prisma.trackedWallet.findUnique({
        where: { address: addr },
      });

      if (existing) {
        const hoursOld = (Date.now() - existing.lastScoredAt.getTime()) / (1000 * 3600);
        if (hoursOld < 48) {
          // Re-use existing scored metrics without consuming Helius credits!
          qualifiedWallets.push({
            address: existing.address,
            label: existing.label || generateWalletAlias(existing.address, existing.strategyProfile as StrategyProfile),
            tier: existing.tier as RiskTier,
            strategyProfile: existing.strategyProfile as StrategyProfile,
            winRate: existing.winRate,
            profitFactor: existing.profitFactor,
            totalTrades: existing.totalTrades,
            medianHoldSeconds: existing.medianHoldSeconds,
            netSolProfit: existing.netSolProfit,
          });
          continue;
        }
      }
    } catch {
      // In case Postgres is temporarily offline, continue with live evaluation
    }
    uncachedCandidates.push(addr);
  }

  console.log(`⚡ ${qualifiedWallets.length} wallets reused from DB cache. Evaluating ${uncachedCandidates.length} new candidates...`);

  // 3. Query transactions and score only uncached candidates (capped at 10 max to preserve quota)
  for (const addr of uncachedCandidates.slice(0, 10)) {
    const txs = await fetchWalletTransactions(addr);
    const scored = evaluateWalletQuantMetrics(addr, txs);
    if (scored) {
      qualifiedWallets.push(scored);

      // Persist to Postgres
      try {
        await prisma.trackedWallet.upsert({
          where: { address: addr },
          update: {
            label: scored.label,
            tier: scored.tier,
            strategyProfile: scored.strategyProfile,
            winRate: scored.winRate,
            profitFactor: scored.profitFactor,
            totalTrades: scored.totalTrades,
            medianHoldSeconds: scored.medianHoldSeconds,
            netSolProfit: scored.netSolProfit,
            isActive: true,
            lastScoredAt: new Date(),
          },
          create: {
            address: addr,
            label: scored.label,
            tier: scored.tier,
            strategyProfile: scored.strategyProfile,
            winRate: scored.winRate,
            profitFactor: scored.profitFactor,
            totalTrades: scored.totalTrades,
            medianHoldSeconds: scored.medianHoldSeconds,
            netSolProfit: scored.netSolProfit,
            isActive: true,
            lastScoredAt: new Date(),
          },
        });
      } catch (err: any) {
        console.warn(`⚠️ Could not save wallet ${addr.slice(0, 6)} to DB:`, err.message);
      }
    }
  }

  // Ensure balanced 50/50 split between SAFE and RISK tiers if no specific tier is filtered
  let finalSelection: ScoredWallet[] = [];
  if (filterTier) {
    const filtered = qualifiedWallets.filter((w) => w.tier === filterTier);
    filtered.sort((a, b) => b.winRate * b.profitFactor - a.winRate * a.profitFactor);
    finalSelection = filtered.slice(0, env.MAX_TRACKED_WALLETS);
  } else {
    const halfLimit = Math.max(1, Math.floor(env.MAX_TRACKED_WALLETS / 2));
    const safeWallets = qualifiedWallets
      .filter((w) => w.tier === RiskTier.SAFE)
      .sort((a, b) => b.winRate * b.profitFactor - a.winRate * a.profitFactor)
      .slice(0, halfLimit);

    const riskWallets = qualifiedWallets
      .filter((w) => w.tier === RiskTier.RISK)
      .sort((a, b) => b.winRate * b.profitFactor - a.winRate * a.profitFactor)
      .slice(0, halfLimit);

    finalSelection = [...safeWallets, ...riskWallets];
    console.log(`🎯 Balanced Roster: ${safeWallets.length} SAFE Wallets | ${riskWallets.length} RISK Wallets`);
  }

  console.log(`✨ Synchronizing total ${finalSelection.length} elite smart-money wallets.`);

  // 4. Update Redis active sets
  await syncWalletsToRedis(finalSelection);

  // 5. Update Helius Webhook dynamically
  if (env.HELIUS_WEBHOOK_ID) {
    await updateHeliusWebhookAddresses(
      env.HELIUS_WEBHOOK_ID,
      finalSelection.map((w) => w.address)
    );
  }

  return finalSelection;
}

// Allow direct CLI execution: tsx src/cron/walletDiscovery.ts
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
  let filterTier: RiskTier | undefined;
  if (profileArg?.includes('safe')) filterTier = RiskTier.SAFE;
  if (profileArg?.includes('risk')) filterTier = RiskTier.RISK;

  runWalletDiscovery(filterTier)
    .then((wallets) => {
      console.log(`🏁 Discovery complete! ${wallets.length} active wallets synchronized.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Discovery failed:', err);
      process.exit(1);
    });
}
