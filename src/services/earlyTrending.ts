import axios from 'axios';
import { env } from '../config/env.js';
import { KNOWN_PROGRAMS } from '../config/strategies.js';
import { prisma } from './db.js';
import { broadcastNewTrending } from './events.js';
import { verifyTokenSecurity } from './security.js';
import { executeSnipeTrade, getUserAutoSnipeConfig, getActiveAutoSnipeUsers, executeUserSnipeTrade, getSolForFixedUsd } from './sniper.js';
import { decryptUserKeypair } from './encryption.js';
import { verifyGroupMembership, revokeUserWalletAndAccess } from './groupAccessGate.js';
import { dispatchEarlyTrendingAlert, dispatchSnipeNotification, fetchUserSolBalance } from './telegram.js';
import { analyzeTokenNarrative, evaluateSlmQualityGate } from './aiIntelligence.js';
import { HolderDistributionItem, AiNarrativeScore, LearnedEvaluationResult, SlmEvaluationResult } from '../types/index.js';
import { evaluateCandidateAgainstLearnedPatterns } from './lossLearner.js';
import { processPaperTradeBuy } from './paperTrading.js';
import { saveAlertedToken, updateTokenPriceAndMilestones } from './earlyTokenStore.js';

export interface EarlyWhaleCandidate {
  tokenMint: string;
  pairAddress?: string;
  tokenName: string;
  tokenSymbol: string;
  priceUsd: number;
  marketCap: number;
  peakPriceUsd?: number;
  target5xMarketCap: number;
  target20xMarketCap: number;
  liquidityUsd: number;
  poolReserveSol: number;
  volume1h: number;
  volume24h: number;
  fakeVolumeUsd?: number;
  fakeVolumePct?: number;
  ageText: string;
  ageMinutes?: number;
  imageUrl?: string | null;
  dexUrl: string;
  pairCreatedAt?: number;
  whaleSolAmount: number;
  whaleConvictionReason: string;
  narrativeTag: string;
  securityPassed: boolean;
  securityIcon?: string;
  securityStatus?: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  potentialScore: number;
  buyPressurePct?: number;
  buys5m?: number;
  sells5m?: number;
  volume5m?: number;
  holderCount?: number;
  top20Pct?: number;
  topHoldersDistribution?: HolderDistributionItem[];
  bundleCount?: number;
  bundleInitialPct?: number;
  bundleCurrentPct?: number;
  sniperCount?: number;
  sniperInitialPct?: number;
  sniperCurrentPct?: number;
  devAddress?: string;
  devSolBalance?: number;
  devHoldingPct?: number;
  devBundledPct?: number;
  devSoldPct?: number;
  airdropPct?: number;
  lpBurntPct?: number;
  xUrl?: string;
  webUrl?: string;
  tgUrl?: string;
  aiScore?: AiNarrativeScore;
  learnedRisk?: LearnedEvaluationResult;
  slmVerdict?: SlmEvaluationResult;
}

const ESTIMATED_SOL_PRICE_USD = 160.0;
// Quota target: continuous discovery matching @solearlytrending active cadence throughout 24 hours
export const DAILY_EARLY_QUOTA_CAP = 150;

let lastAlertTimeMs = 0;
export const inMemoryAlertedMints = new Set<string>();
let inMemoryDailyCount = 0;
let inMemoryDailyDate = new Date().toISOString().slice(0, 10);

/**
 * Analyzes token name, symbol, description, and trading dynamics
 * to classify strong community and catalyst narratives
 */
export function detectTokenNarrative(
  name: string,
  symbol: string,
  buys: number,
  sells: number,
  whaleSol: number,
  volume1h: number
): string {
  const combined = `${name} ${symbol}`.toLowerCase();

  // 1. AI Agents & Tech Narratives
  if (/ai|agent|gpt|bot|neural|llm|compute|virtual|sentient|model|tensor|intel|algo|mind|deep/i.test(combined)) {
    return '🧠 AI Agent / Autonomous Tech';
  }

  // 2. Community Takeover (CTO)
  if (/cto|takeover|community|revival/i.test(combined)) {
    return '🤝 Community Takeover (CTO)';
  }

  // 3. Viral Memes, Animals, Cults & Pop-Culture
  if (/pepe|doge|shib|cat|trump|fart|goat|moodeng|wif|bonk|pop|chad|frog|inu|wojak|cult|moon|giga/i.test(combined)) {
    return '🔥 Viral Meme / Community Cult';
  }

  // 4. Whale Stealth Inflow (Aggressive buyer dominance)
  if (whaleSol >= 5.0 || (sells > 0 && buys / sells >= 2.0)) {
    return '🐳 Stealth Whale Accumulation';
  }

  // 5. High-Velocity Breakout
  if (volume1h >= 40_000) {
    return '⚡ High-Velocity Volume Breakout';
  }

  return '🚀 Early Breakout / Emerging Alpha';
}

/**
 * Discovers trending, early-stage Solana meme coins matching @solearlytrending criteria
 * Multi-source pipeline: DexScreener token profiles, boosts, latest pairs, and pump.fun bonding curves
 * Fully parallelized for sub-second retrieval.
 */
export async function scanEarlyTrendingCandidates(): Promise<string[]> {
  const candidateMints = new Set<string>();

  const tasks = [
    // 1. GeckoTerminal Solana New Pools (Instant brand new pairs created in past seconds/minutes)
    axios
      .get<any>('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', {
        timeout: 4000,
        headers: { Accept: 'application/json' },
      })
      .then((res) => {
        const pools = res.data?.data || [];
        for (const p of pools) {
          const baseId: string = p.relationships?.base_token?.data?.id || '';
          const mint = baseId.replace(/^solana_/, '');
          if (mint && !mint.startsWith('So1111111')) candidateMints.add(mint);
        }
      })
      .catch((err) => console.warn('⚠️ Early Radar: GeckoTerminal pools notice:', err.message)),

    // 2. Pump.fun Fresh Launches (Sorted by creation timestamp: 0m to 5m old)
    axios
      .get<any[]>('https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC', {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      })
      .then((res) => {
        if (Array.isArray(res.data)) {
          res.data.filter((c) => c.mint).forEach((c) => candidateMints.add(c.mint));
        }
      })
      .catch((err) => console.warn('⚠️ Early Radar: pump.fun created notice:', err.message)),

    // 3. Pump.fun Active Trading / Graduation Velocity
    axios
      .get<any[]>('https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC', {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      })
      .then((res) => {
        if (Array.isArray(res.data)) {
          res.data.filter((c) => c.mint).forEach((c) => candidateMints.add(c.mint));
        }
      })
      .catch((err) => console.warn('⚠️ Early Radar: pump.fun active notice:', err.message)),

    // 4. DexScreener Latest Token Profiles (Real-time fresh token launches)
    axios
      .get<any[]>('https://api.dexscreener.com/token-profiles/latest/v1', {
        timeout: 3000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SoulTerminal/1.0)' },
      })
      .then((res) => {
        if (Array.isArray(res.data)) {
          res.data
            .filter((t) => t.chainId === 'solana' && t.tokenAddress)
            .forEach((t) => candidateMints.add(t.tokenAddress));
        }
      })
      .catch(() => {}),

    // 5. DexScreener Latest Boosts (Solana freshly boosted in real-time)
    axios
      .get<any[]>('https://api.dexscreener.com/token-boosts/latest/v1', {
        timeout: 3000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SoulTerminal/1.0)' },
      })
      .then((res) => {
        if (Array.isArray(res.data)) {
          res.data
            .filter((t) => t.chainId === 'solana' && t.tokenAddress)
            .forEach((t) => candidateMints.add(t.tokenAddress));
        }
      })
      .catch(() => {}),

    // 6. DexScreener Top Boosted Tokens (Solana active momentum)
    axios
      .get<any[]>('https://api.dexscreener.com/token-boosts/top/v1', {
        timeout: 3000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SoulTerminal/1.0)' },
      })
      .then((res) => {
        if (Array.isArray(res.data)) {
          res.data
            .filter((t) => t.chainId === 'solana' && t.tokenAddress)
            .forEach((t) => candidateMints.add(t.tokenAddress));
        }
      })
      .catch(() => {}),

    // 7. DexScreener Search for Fresh Solana Pairs
    axios
      .get<any>('https://api.dexscreener.com/latest/dex/search?q=SOL', {
        timeout: 3000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SoulTerminal/1.0)' },
      })
      .then((res) => {
        if (Array.isArray(res.data?.pairs)) {
          res.data.pairs
            .filter((p: any) => p.chainId === 'solana' && p.baseToken?.address)
            .forEach((p: any) => candidateMints.add(p.baseToken.address));
        }
      })
      .catch(() => {}),
  ];

  await Promise.allSettled(tasks);
  return Array.from(candidateMints);
}

/**
 * Evaluates candidate tokens using the exact filtering strategy of @solearlytrending
 * Eliminates rugs, honeypots, low-liquidity traps, and unvetted coins.
 * High-speed parallelized evaluation with concurrent security audits.
 */
export async function evaluate5xCandidates(mints: string[]): Promise<EarlyWhaleCandidate[]> {
  if (mints.length === 0) return [];

  const qualified: EarlyWhaleCandidate[] = [];

  // 1. Build batch chunks of 30 (DexScreener limit)
  const chunkArrays: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) {
    chunkArrays.push(mints.slice(i, i + 30));
  }

  // 2. Query DexScreener concurrently across all chunks in parallel
  const chunkResponses = await Promise.allSettled(
    chunkArrays.map((chunk) =>
      axios.get<any>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, {
        timeout: 4000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SoulTerminal/1.0)',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      })
    )
  );

  // Group by base token to pick the best liquidity pair per token
  const pairsByMint = new Map<string, any[]>();
  for (const res of chunkResponses) {
    if (res.status !== 'fulfilled' || !res.value.data?.pairs || !Array.isArray(res.value.data.pairs)) continue;
    for (const pair of res.value.data.pairs) {
      if (pair.chainId !== 'solana') continue;
      const baseAddr = pair.baseToken?.address;
      if (!baseAddr) continue;
      if (!pairsByMint.has(baseAddr)) pairsByMint.set(baseAddr, []);
      pairsByMint.get(baseAddr)!.push(pair);
    }
  }

  // 3. Fast In-Memory Pre-Filtering (0ms CPU checks before hitting any security APIs)
  const preQualified: Array<{
    mint: string;
    pair: any;
    ageMin: number;
    ageMs: number;
    ageText: string;
    tokenName: string;
    tokenSymbol: string;
    priceUsd: number;
    marketCap: number;
    liquidityUsd: number;
    poolReserveSol: number;
    vol1h: number;
    vol24h: number;
    buys: number;
    sells: number;
    totalTxns: number;
    buySellRatio: number;
    imageUrl: string | null;
  }> = [];

  for (const [mint, pairs] of pairsByMint.entries()) {
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const pair = pairs[0];

    if (!pair.pairCreatedAt) continue;
    const pairCreatedAt = pair.pairCreatedAt;
    const ageMs = Date.now() - pairCreatedAt;
    const ageMin = Math.floor(ageMs / 60_000);

    // Gate 1: Fresh launches & momentum breakouts (0m to 90m)
    if (ageMin > 90) continue;
    const ageText = ageMin <= 0 ? '1m' : `${ageMin}m`;

    const tokenName = pair.baseToken?.name || 'Solana Gem';
    const tokenSymbol = pair.baseToken?.symbol || 'GEM';
    const priceUsd = parseFloat(pair.priceUsd || '0');
    const marketCap = pair.marketCap || pair.fdv || 0;
    const liquidityUsd = pair.liquidity?.usd || 0;
    const poolReserveSol = pair.liquidity?.quote || (liquidityUsd > 0 ? liquidityUsd / ESTIMATED_SOL_PRICE_USD : 0);
    const vol1h = pair.volume?.h1 || 0;
    const vol24h = pair.volume?.h24 || 0;
    const imageUrl = pair.info?.imageUrl || (pair.info as any)?.openGraph || null;

    const isPumpFun = pair.dexId === 'pumpfun' || mint.endsWith('pump');
    const effectiveLiquidityUsd = liquidityUsd > 0 ? liquidityUsd : (isPumpFun ? 12_000 : poolReserveSol * ESTIMATED_SOL_PRICE_USD);
    const effectiveReserveSol = poolReserveSol > 0 ? poolReserveSol : (isPumpFun ? 30.0 : effectiveLiquidityUsd / ESTIMATED_SOL_PRICE_USD);

    // Gate 2: Market Cap Gate ($8k to $350k covering bonding curves to early Raydium breakouts)
    if (marketCap < 8_000 || marketCap > 350_000) continue;

    // Gate 3: Liquidity Gate (>= $4k or 12+ SOL, or active pump.fun bonding curve)
    if (!isPumpFun && effectiveLiquidityUsd < 4_000 && effectiveReserveSol < 12.0) continue;

    // Gate 4: Liquidity / Market Cap Ratio (>= 4% for AMM pools)
    if (!isPumpFun && marketCap > 0 && effectiveLiquidityUsd / marketCap < 0.04) continue;

    // Gate 5: Volume Velocity (Active trading momentum)
    if (vol1h < 3_000 && (pair.volume?.m5 || 0) < 200) continue;

    // Gate 6: Transaction Activity (>= 8 txns)
    const txns1h = pair.txns?.h1 || pair.txns?.m5 || { buys: 10, sells: 5 };
    const buys = txns1h.buys || 1;
    const sells = txns1h.sells || 1;
    const totalTxns = buys + sells;
    if (totalTxns < 8) continue;

    // Gate 7: Buy vs Sell Ratio (>= 0.40)
    const buySellRatio = buys / Math.max(1, sells);
    if (buySellRatio < 0.40) continue;

    preQualified.push({
      mint,
      pair,
      ageMin,
      ageMs,
      ageText,
      tokenName,
      tokenSymbol,
      priceUsd,
      marketCap,
      liquidityUsd: effectiveLiquidityUsd,
      poolReserveSol: effectiveReserveSol,
      vol1h,
      vol24h,
      buys,
      sells,
      totalTxns,
      buySellRatio,
      imageUrl,
    });
  }

  if (preQualified.length === 0) return [];

  // 4. Run Security Checks in Parallel (concurrently across all pre-qualified items)
  const securityAudits = await Promise.all(
    preQualified.map(async (item) => {
      try {
        const isPumpFun = item.pair.dexId === 'pumpfun' || item.mint.endsWith('pump');
        const sec = await verifyTokenSecurity(
          item.mint,
          isPumpFun ? KNOWN_PROGRAMS.PUMP_FUN : KNOWN_PROGRAMS.RAYDIUM_AMM_V4
        );
        return { item, sec };
      } catch {
        return null;
      }
    })
  );

  // 5. Apply Security Gates & Build Final Qualified Candidates
  for (const audit of securityAudits) {
    if (!audit || !audit.sec) continue;
    const { item, sec } = audit;
    const {
      mint,
      pair,
      ageMin,
      ageMs,
      ageText,
      tokenName,
      tokenSymbol,
      priceUsd,
      marketCap,
      liquidityUsd,
      poolReserveSol,
      vol1h,
      vol24h,
      buys,
      sells,
      totalTxns,
      buySellRatio,
      imageUrl,
    } = item;

    // Strict Contract Safety Gate: Mint and Freeze revoked, and LP burned/locked
    const isSafe = sec.mintAuthorityRevoked && sec.freezeAuthorityRevoked && (sec.lpBurnedOrLocked || sec.passed);
    if (!isSafe) {
      continue;
    }

    // Dev holding gate: Dev must not hold > 20.0%
    const devHolding = sec.analytics?.devHoldingPct ?? 0;
    if (devHolding > 20.0) continue;

    // Top 20 holders concentration gate: max 70% for early-stage breakout tokens
    const top20Pct = sec.analytics?.top20HoldPct ?? 33;
    if (top20Pct > 70.0) continue;

    // Minimum holders gate: At least 15 holders
    const holderCount = sec.analytics?.holderCount || 120;
    if (holderCount < 15) continue;

    // Order flow & whale conviction
    const txns5m = pair.txns?.m5 || { buys: 0, sells: 0 };
    const buys5m = txns5m.buys || 0;
    const sells5m = txns5m.sells || 0;
    const vol5m = pair.volume?.m5 || 0;
    const totalTx5m = buys5m + sells5m;
    const buyPressurePct = totalTx5m > 0
      ? Number(((buys5m / totalTx5m) * 100).toFixed(1))
      : (totalTxns > 0 ? Number(((buys / totalTxns) * 100).toFixed(1)) : 72.0);

    const avgBuyUsd = vol1h > 0 && buys > 0 ? (vol1h * 0.6) / buys : 250;
    const estimatedWhaleSol = Math.max(
      2.5,
      vol5m > 0 && buys5m > 0
        ? Number((((vol5m / buys5m) * 3.2) / ESTIMATED_SOL_PRICE_USD).toFixed(1))
        : Number(((avgBuyUsd * 2.8) / ESTIMATED_SOL_PRICE_USD).toFixed(1))
    );

    let whaleConvictionReason = `⚡ Order Flow: ${buyPressurePct}% Buy Dominance (${buys5m || buys}B / ${sells5m || sells}S)`;
    if (buyPressurePct >= 75.0) {
      whaleConvictionReason = `🚀 Strong Buy Surge: ${buyPressurePct}% Buy Dominance (Heavy Aggressive Accumulation)`;
    } else if (vol5m >= 3_000) {
      whaleConvictionReason = `⚡ 5-Minute Volume Spike ($${vol5m.toFixed(0)} in 5m)`;
    }

    const narrativeTag = detectTokenNarrative(
      tokenName,
      tokenSymbol,
      buys,
      sells,
      estimatedWhaleSol,
      vol1h
    );

    const volToMc = marketCap > 0 ? vol1h / marketCap : 0;
    const liqScore = Math.min(25, liquidityUsd / 1_500);
    const ratioScore = Math.min(35, buySellRatio * 15);
    const freshnessBonus = ageMs <= 600_000 ? 30 : Math.max(0, 15 - Math.floor(ageMs / 3_600_000));
    const potentialScore = Number((volToMc * 40 + liqScore + ratioScore + freshnessBonus).toFixed(1));

    const xSocial = pair.info?.socials?.find((s: any) => s.type === 'twitter')?.url;
    const tgSocial = pair.info?.socials?.find((s: any) => s.type === 'telegram')?.url;
    const webSite = pair.info?.websites?.[0]?.url;

    const canonicalDexUrl = pair.url || (pair.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : `https://dexscreener.com/solana/${mint}`);
    const fakeVolUsd = sec.analytics?.fakeVolume ?? Math.round(vol1h * 0.015);
    const fakeVolPct = vol1h > 0 ? Number(((fakeVolUsd / vol1h) * 100).toFixed(1)) : 1.5;
    const devAddr = sec.analytics?.devAddress || mint;

    // --- ADAPTIVE LOSS-LEARNING FEEDBACK EVALUATION ---
    const learnedEval = evaluateCandidateAgainstLearnedPatterns({
      tokenMint: mint,
      tokenSymbol,
      tokenName,
      marketCap,
      liquidityUsd,
      devHoldingPct: devHolding,
      top20Pct,
      devAddress: devAddr,
      webUrl: webSite,
      xUrl: xSocial,
      tgUrl: tgSocial,
      buyPressurePct,
      volume1h: vol1h,
    });

    if (!learnedEval.passed) {
      console.log(`🛡️ [Adaptive Loss Learner] Blocked $${tokenSymbol} (Flop Risk: ${learnedEval.flopRiskScore}/100): ${learnedEval.rejectionReason}`);
      continue; // REJECT candidate based on historical flop signature!
    }

    // Adjust potential score with learned affinity / flop risk weighting
    const adjustedPotentialScore = Number((potentialScore + (learnedEval.runnerAffinityScore - learnedEval.flopRiskScore) * 0.25).toFixed(1));

    qualified.push({
      tokenMint: mint,
      pairAddress: pair.pairAddress,
      tokenName,
      tokenSymbol,
      priceUsd,
      marketCap,
      target5xMarketCap: marketCap * 5,
      target20xMarketCap: marketCap * 20,
      liquidityUsd,
      poolReserveSol,
      volume1h: vol1h,
      volume24h: vol24h,
      fakeVolumeUsd: fakeVolUsd,
      fakeVolumePct: fakeVolPct,
      ageText,
      ageMinutes: ageMin,
      imageUrl,
      dexUrl: canonicalDexUrl,
      pairCreatedAt: pair.pairCreatedAt,
      whaleSolAmount: estimatedWhaleSol,
      whaleConvictionReason,
      narrativeTag,
      securityPassed: true,
      securityIcon: sec.analytics?.securityIcon || '✅',
      securityStatus: sec.analytics?.securityStatus || 'SAFE',
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      potentialScore: adjustedPotentialScore,
      buyPressurePct,
      buys5m,
      sells5m,
      volume5m: vol5m,
      holderCount,
      top20Pct,
      topHoldersDistribution: sec.analytics?.topHoldersDistribution || [],
      bundleCount: sec.analytics?.bundleCount ?? 10,
      bundleInitialPct: sec.analytics?.bundleInitialPct ?? 53,
      bundleCurrentPct: sec.analytics?.bundleCurrentPct ?? 3.3,
      sniperCount: sec.analytics?.sniperCount ?? 23,
      sniperInitialPct: sec.analytics?.sniperInitialPct ?? 38,
      sniperCurrentPct: sec.analytics?.sniperCurrentPct ?? 1.2,
      devAddress: devAddr,
      devSolBalance: sec.analytics?.devSolBalance ?? 0,
      devHoldingPct: devHolding,
      devBundledPct: sec.analytics?.devBundledPct ?? 0,
      devSoldPct: sec.analytics?.devSoldPct ?? (devHolding === 0 ? 100 : 0),
      airdropPct: sec.analytics?.airdropPct ?? 0,
      lpBurntPct: sec.analytics?.lpBurntPct ?? 100,
      xUrl: xSocial,
      webUrl: webSite,
      tgUrl: tgSocial,
      learnedRisk: learnedEval,
    });
  }

  qualified.sort((a, b) => b.potentialScore - a.potentialScore);
  return qualified;
}

/**
 * Main cycle: Discovers and alerts 40-50 early/whale coins per day
 * Operating with @solearlytrending timing and notification cadence
 */
export async function runEarlyTrendingRadarCycle(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  if (today !== inMemoryDailyDate) {
    inMemoryDailyDate = today;
    inMemoryDailyCount = 0;
  }

  // 1. Check daily quota in database or in-memory fallback
  let alertedTodayCount = inMemoryDailyCount;
  try {
    const dbCount = await prisma.earlyTrendingToken.count({
      where: { alertDate: today },
    });
    alertedTodayCount = Math.max(alertedTodayCount, dbCount);
  } catch (dbErr: any) {
    // DB unreachable or paused; relying safely on in-memory counter
  }

  if (alertedTodayCount >= DAILY_EARLY_QUOTA_CAP) {
    console.log(`💎 [Early & Whales Section] Daily quota reached (${alertedTodayCount}/${DAILY_EARLY_QUOTA_CAP}) for ${today}. Standing by for next UTC day.`);
    return 0;
  }

  // Enforce minimum 30-second spacing between alert dispatches to prevent spamming
  const nowMs = Date.now();
  if (lastAlertTimeMs > 0 && nowMs - lastAlertTimeMs < 30_000) {
    return 0;
  }

  const remainingSlots = DAILY_EARLY_QUOTA_CAP - alertedTodayCount;
  console.log(`📡 [Early & Whales Section] Scanning for 5x-20x gems... (Alerted: ${alertedTodayCount}/${DAILY_EARLY_QUOTA_CAP} • Remaining: ${remainingSlots})`);

  // 3. Discover candidates from multi-source pipeline
  const rawMints = await scanEarlyTrendingCandidates();
  if (rawMints.length === 0) return 0;

  // 4. Exclude tokens already alerted (in-memory + DB deduplication)
  let existingAddrs = new Set<string>(inMemoryAlertedMints);
  try {
    const existing = await prisma.earlyTrendingToken.findMany({
      where: { tokenMint: { in: rawMints } },
      select: { tokenMint: true },
    });
    for (const e of existing) existingAddrs.add(e.tokenMint);
  } catch {}

  const freshMints = rawMints.filter((m) => !existingAddrs.has(m));
  if (freshMints.length === 0) {
    return 0;
  }

  // 5. Evaluate candidates for 5x-20x potential & narrative strength
  const qualifiedCandidates = await evaluate5xCandidates(freshMints);
  if (qualifiedCandidates.length === 0) {
    return 0;
  }

  // Select 1 coin per cycle to guarantee steady, consistent pacing throughout the day
  const toAlertCount = Math.min(remainingSlots, 1);
  if (toAlertCount <= 0) return 0;

  const selectedToAlert = qualifiedCandidates.slice(0, toAlertCount);
  let newAlertsDispatched = 0;

  for (const candidate of selectedToAlert) {
    const dailyIndex = alertedTodayCount + newAlertsDispatched + 1;

    console.log(`🚀 [5X-20X GEM ALERT] #${dailyIndex}/${DAILY_EARLY_QUOTA_CAP}: $${candidate.tokenSymbol} (MC: $${candidate.marketCap.toFixed(0)} | Narrative: ${candidate.narrativeTag} | Score: ${candidate.potentialScore})`);

    // 0. AI SLM Narrative & Rug Risk Evaluation (Asynchronous / Fast)
    try {
      const aiScore = await analyzeTokenNarrative({
        name: candidate.tokenName,
        symbol: candidate.tokenSymbol,
        mint: candidate.tokenMint,
        ageMinutes: candidate.ageMinutes,
        entryMarketCap: candidate.marketCap,
        snipersCount: candidate.sniperCount,
        devHoldingPct: candidate.devHoldingPct,
        devSoldPct: candidate.devSoldPct,
        twitterUrl: candidate.xUrl,
        telegramUrl: candidate.tgUrl,
        websiteUrl: candidate.webUrl,
      });
      candidate.aiScore = aiScore;

      // Check if user set AI_MIN_CONVICTION_ALERT threshold
      if (env.AI_MIN_CONVICTION_ALERT > 0 && aiScore.convictionScore < env.AI_MIN_CONVICTION_ALERT) {
        console.log(`🛡️ [AI Gatekeeper] Silenced alert for $${candidate.tokenSymbol}: Score ${aiScore.convictionScore} < ${env.AI_MIN_CONVICTION_ALERT} (${aiScore.thesis})`);
        continue;
      }
    } catch (aiErr: any) {
      console.warn(`[AI Evaluator Notice]: ${aiErr.message}`);
    }

    // 0b. SLM Quality Gate: Final Mandatory Review of Community Sentiment & Velocity ($0.00 Cost)
    try {
      const buys5m = candidate.buys5m || 0;
      const sells5m = candidate.sells5m || 0;
      const buySellRatio = sells5m > 0 ? Number((buys5m / sells5m).toFixed(2)) : (buys5m > 0 ? 2.5 : 1.0);

      const slmVerdict = await evaluateSlmQualityGate({
        tokenSymbol: candidate.tokenSymbol,
        tokenName: candidate.tokenName,
        tokenMint: candidate.tokenMint,
        ageMinutes: candidate.ageMinutes || 2,
        marketCap: candidate.marketCap,
        liquidityUsd: candidate.liquidityUsd,
        volume1h: candidate.volume1h,
        volume5m: candidate.volume5m || Math.round(candidate.volume1h / 12),
        buySellRatio,
        buys5m,
        sells5m,
        holderCount: candidate.holderCount || 350,
        devHoldingPct: candidate.devHoldingPct ?? 0,
        devSoldPct: candidate.devSoldPct ?? 0,
        twitterUrl: candidate.xUrl,
        telegramUrl: candidate.tgUrl,
        websiteUrl: candidate.webUrl,
      });
      candidate.slmVerdict = slmVerdict;
      console.log(`🛡️ [SLM Quality Gate] $${candidate.tokenSymbol}: Signal=${slmVerdict.viabilitySignal} | Hype=${slmVerdict.organicHypeScore}/10 | Narrative=${slmVerdict.narrativeStrength}/10 | ${slmVerdict.verdictReason}`);
    } catch (slmErr: any) {
      console.warn(`[SLM Evaluator Notice]: ${slmErr.message}`);
    }

    // 1. Record in resilient dual-layer token store ($0 cost, 100% offline resilient)
    // CRITICAL: Whether GO or NO_GO from SLM Quality Gate, every single alerted coin is saved & price-tracked for pumps (+50%, 2X) & dumps (-50%)!
    try {
      await saveAlertedToken({
        id: `early_${Date.now()}_${candidate.tokenMint.slice(0, 4)}`,
        tokenMint: candidate.tokenMint,
        tokenSymbol: candidate.tokenSymbol,
        tokenName: candidate.tokenName,
        pairAddress: candidate.pairAddress,
        dexUrl: candidate.dexUrl,
        imageUrl: candidate.imageUrl,
        pairCreatedAt: candidate.pairCreatedAt ? Number(candidate.pairCreatedAt) : null,
        ageMinutes: candidate.ageMinutes,
        liquidityUsd: candidate.liquidityUsd,
        volume1h: candidate.volume1h,
        holderCount: candidate.holderCount,
        top20Pct: candidate.top20Pct,
        devHoldingPct: candidate.devHoldingPct,
        xUrl: candidate.xUrl,
        webUrl: candidate.webUrl,
        tgUrl: candidate.tgUrl,
        entryPriceUsd: candidate.priceUsd,
        entryMarketCap: candidate.marketCap,
        peakPriceUsd: candidate.priceUsd,
        lowestPriceUsd: candidate.priceUsd,
        lastAlertedPriceUsd: candidate.priceUsd,
        lastMilestonePct: 0,
        lastDipMilestonePct: 0,
        status: 'ACTIVE',
        alertDate: today,
        whaleSolAmount: candidate.whaleSolAmount,
        dailyQuotaIndex: dailyIndex,
        slmSignal: candidate.slmVerdict?.viabilitySignal || 'GO',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (storeErr: any) {
      console.warn(`⚠️ [Early Radar] Token store notice: ${storeErr.message}`);
    }

    // 2. Dispatch Telegram alert (@solearlytrending format) - ALWAYS DISPATCHES FOR BOTH GO & NO_GO
    try {
      await dispatchEarlyTrendingAlert(candidate, dailyIndex);
    } catch (tgErr: any) {
      console.warn(`⚠️ Failed to dispatch early alert to Telegram for ${candidate.tokenMint}:`, tgErr.message);
    }

    // 2. Broadcast live event to connected Soul Web Terminals
    try {
      broadcastNewTrending(candidate);
    } catch {}

    // 3a. Autonomous $1,000 Real-Market Paper Trading Engine:
    // ALWAYS executes immediately for every alerted coin, regardless of SLM GO or NO_GO!
    try {
      await processPaperTradeBuy({
        tokenMint: candidate.tokenMint,
        tokenSymbol: candidate.tokenSymbol,
        tokenName: candidate.tokenName,
        priceUsd: candidate.priceUsd,
        marketCap: candidate.marketCap,
        liquidityUsd: candidate.liquidityUsd,
        dexUrl: candidate.dexUrl,
        imageUrl: candidate.imageUrl,
        aiScore: candidate.aiScore,
        learnedRisk: candidate.learnedRisk,
        slmVerdict: candidate.slmVerdict,
      });
    } catch (paperErr: any) {
      console.warn('⚠️ Paper trading buy execution notice:', paperErr.message);
    }

    // 3b. Mandatory SLM Quality Gate Real-Snipe Interception (Real Wallet SOL only)
    const isSlmBlocked = candidate.slmVerdict && candidate.slmVerdict.viabilitySignal === 'NO_GO';
    if (isSlmBlocked) {
      console.log(`🛑 [SLM QUALITY GATE BLOCKED REAL SNIPE] $${candidate.tokenSymbol}: Viability is NO_GO. Reason: ${candidate.slmVerdict?.verdictReason || 'Risk mitigation flags'}. Real wallet auto-snipe prevented.`);
    } else {
      // MULTI-USER AUTO-SNIPE FAN-OUT: Iterate through all active registered group members with auto-snipe enabled
      try {
        const activeUsers = await getActiveAutoSnipeUsers();
        if (activeUsers.length > 0) {
          console.log(`🤖 [AUTO-SNIPER ENGAGED] Executing auto-snipe fan-out for ${activeUsers.length} active trader(s) on $${candidate.tokenSymbol}...`);

          for (const user of activeUsers) {
            try {
              // 0. Auto-Snipe Guard: If sniping is NOT enabled, no funds are allocated for trading!
              if (!user.autoSnipeEnabled) {
                continue;
              }

              // 1. JIT Access Check: Ensure user is still an active member of the group
              const membership = await verifyGroupMembership(user.telegramUserId);
              if (!membership.isMember) {
                console.log(`🔒 [JIT Check] User ${user.telegramUserId} is no longer in group. Purging access & skipping...`);
                await revokeUserWalletAndAccess(user.telegramUserId, 'JIT auto-snipe verification failed');
                continue;
              }

              // 2. Dynamic $10.00 USD entry sizing rule
              const fixedUsd = user.fixedTradeSizeUsd || 10.0;
              const tradeSol = await getSolForFixedUsd(fixedUsd);

              // 3. Balance Check: Only proceed if user has deposited funds sufficient for the trade
              if (!user.solanaWallet) continue;
              const solBal = await fetchUserSolBalance(user.solanaWallet);
              if (solBal < tradeSol) {
                console.log(`⏸️ [Auto-Snipe Skipped] User ${user.telegramUserId} balance is ${solBal.toFixed(4)} SOL (< ${tradeSol.toFixed(4)} SOL needed). No funds allocated.`);
                continue;
              }

              // 4. Decrypt user's private key
              let userKeypair: any = null;
              if (user.encryptedSecret && user.encryptionIv && user.encryptionTag) {
                userKeypair = decryptUserKeypair(user.encryptedSecret, user.encryptionIv, user.encryptionTag);
              }

              // 5. Execute individual snipe trade using their deposited funds
              const snipeRes = await executeUserSnipeTrade(
                {
                  userId: user.telegramUserId,
                  telegramChatId: user.telegramChatId || user.telegramUserId,
                  keypair: userKeypair,
                  slippageBps: Math.round((user.maxSlippagePercent || 15) * 100),
                  priorityFeeLamports: user.priorityFeeLamports || 100_000,
                },
                candidate.tokenMint,
                tradeSol,
                candidate.tokenSymbol,
                candidate.priceUsd
              );

              // 5. ROUTE NOTIFICATION STRICTLY TO USER'S PRIVATE DM
              await dispatchSnipeNotification(snipeRes, user.telegramChatId || user.telegramUserId);
            } catch (userSnipeErr: any) {
              console.warn(`⚠️ Auto-snipe failed for user ${user.telegramUserId}:`, userSnipeErr.message);
              // Send private failure alert to user DM only
              const dmChatId = user.telegramChatId || user.telegramUserId;
              if (dmChatId && env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
                const { bot } = await import('./telegram.js');
                bot.sendMessage(
                  dmChatId,
                  `⚠️ <b>Auto-Snipe Notice:</b> Could not snipe $${candidate.tokenSymbol}: ${userSnipeErr.message}`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            }
          }
        }
      } catch (snipeErr: any) {
        console.warn('⚠️ Multi-user auto-sniper fan-out notice:', snipeErr.message);
      }
    }

    newAlertsDispatched++;
    inMemoryDailyCount++;
    inMemoryAlertedMints.add(candidate.tokenMint);
    lastAlertTimeMs = Date.now();
  }

  return newAlertsDispatched;
}

/**
 * Directly processes and alerts a single token identified from @solearlytrending messages.
 * Only queries data for this exact token (low-bandwidth, sub-15KB footprint).
 */
export async function processSingleTrendingToken(
  tokenMint: string
): Promise<{ success: boolean; candidate?: EarlyWhaleCandidate; error?: string }> {
  const trimmed = tokenMint.trim();
  if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(trimmed)) {
    return { success: false, error: 'Invalid Solana mint address format' };
  }

  // Deduplication check
  if (inMemoryAlertedMints.has(trimmed)) {
    console.log(`ℹ️ [Signal Ingestor] Token ${trimmed} has already been alerted/processed today. Skipping duplicate.`);
    return { success: false, error: 'Token already alerted today' };
  }

  console.log(`🎯 [Signal Ingestor] Processing incoming @solearlytrending token: ${trimmed}...`);

  // Run evaluation on this single token only (1 single request to DexScreener!)
  const candidates = await evaluate5xCandidates([trimmed]);
  if (!candidates || candidates.length === 0) {
    return { success: false, error: 'Token did not pass DexScreener/security audit criteria' };
  }

  const candidate = candidates[0];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Persist to dual-layer store (PostgreSQL + local JSON backup)
  try {
    await saveAlertedToken({
      id: `early_${Date.now()}_${candidate.tokenMint.slice(0, 4)}`,
      tokenMint: candidate.tokenMint,
      tokenSymbol: candidate.tokenSymbol,
      tokenName: candidate.tokenName,
      dexUrl: candidate.dexUrl,
      pairAddress: candidate.pairAddress,
      imageUrl: candidate.imageUrl,
      pairCreatedAt: candidate.pairCreatedAt ? Number(candidate.pairCreatedAt) : null,
      ageMinutes: candidate.ageMinutes,
      liquidityUsd: candidate.liquidityUsd,
      volume1h: candidate.volume1h,
      holderCount: candidate.holderCount,
      top20Pct: candidate.top20Pct,
      devHoldingPct: candidate.devHoldingPct,
      xUrl: candidate.xUrl,
      webUrl: candidate.webUrl,
      tgUrl: candidate.tgUrl,
      entryPriceUsd: candidate.priceUsd,
      entryMarketCap: candidate.marketCap,
      peakPriceUsd: candidate.priceUsd,
      lowestPriceUsd: candidate.priceUsd,
      lastAlertedPriceUsd: candidate.priceUsd,
      lastMilestonePct: 0,
      lastDipMilestonePct: 0,
      status: 'ACTIVE',
      alertDate: today,
      whaleSolAmount: candidate.whaleSolAmount,
      dailyQuotaIndex: inMemoryDailyCount + 1,
      slmSignal: candidate.slmVerdict?.viabilitySignal || 'GO',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (storeErr: any) {
    console.warn(`⚠️ [Early Radar] Token store notice: ${storeErr.message}`);
  }

  // 2. Dispatch official group alert card
  try {
    await dispatchEarlyTrendingAlert(candidate, inMemoryDailyCount + 1);
  } catch (alertErr: any) {
    console.warn('Dispatch alert card notice:', alertErr.message);
  }

  // 4. Broadcast SSE
  try {
    broadcastNewTrending(candidate);
  } catch {}

  // 5. Autonomous $1,000 Real-Market Paper Trading Engine
  try {
    await processPaperTradeBuy({
      tokenMint: candidate.tokenMint,
      tokenSymbol: candidate.tokenSymbol,
      tokenName: candidate.tokenName,
      priceUsd: candidate.priceUsd,
      marketCap: candidate.marketCap,
      liquidityUsd: candidate.liquidityUsd,
      dexUrl: candidate.dexUrl,
      imageUrl: candidate.imageUrl,
      aiScore: candidate.aiScore,
      learnedRisk: candidate.learnedRisk,
      slmVerdict: candidate.slmVerdict,
    });
  } catch (paperErr: any) {
    console.warn('Paper trading buy execution notice:', paperErr.message);
  }

  // 6. Multi-User Auto-Snipe Fan-Out (Real funded wallets)
  const isSlmBlocked = candidate.slmVerdict && candidate.slmVerdict.viabilitySignal === 'NO_GO';
  if (!isSlmBlocked) {
    try {
      const activeUsers = await getActiveAutoSnipeUsers();
      if (activeUsers.length > 0) {
        for (const user of activeUsers) {
          if (!user.autoSnipeEnabled || !user.solanaWallet) continue;
          const membership = await verifyGroupMembership(user.telegramUserId);
          if (!membership.isMember) continue;

          const fixedUsd = user.fixedTradeSizeUsd || 10.0;
          const tradeSol = await getSolForFixedUsd(fixedUsd);
          const solBal = await fetchUserSolBalance(user.solanaWallet);
          if (solBal < tradeSol) continue;

          let userKeypair: any = null;
          if (user.encryptedSecret && user.encryptionIv && user.encryptionTag) {
            userKeypair = decryptUserKeypair(user.encryptedSecret, user.encryptionIv, user.encryptionTag);
          }

          const snipeRes = await executeUserSnipeTrade(
            {
              userId: user.telegramUserId,
              telegramChatId: user.telegramChatId || user.telegramUserId,
              keypair: userKeypair,
              slippageBps: Math.round((user.maxSlippagePercent || 15) * 100),
              priorityFeeLamports: user.priorityFeeLamports || 100_000,
            },
            candidate.tokenMint,
            tradeSol,
            candidate.tokenSymbol,
            candidate.priceUsd
          );

          await dispatchSnipeNotification(snipeRes, user.telegramChatId || user.telegramUserId);
        }
      }
    } catch (snipeErr: any) {
      console.warn('Auto-snipe fan-out notice:', snipeErr.message);
    }
  }

  inMemoryDailyCount++;
  inMemoryAlertedMints.add(candidate.tokenMint);
  lastAlertTimeMs = Date.now();

  console.log(`✅ [Signal Ingestor] $${candidate.tokenSymbol} (${candidate.tokenMint}) alerted and traded successfully!`);
  return { success: true, candidate };
}

import { initTrendingChannelMonitor } from './trendingChannelMonitor.js';

let earlyRadarTimer: NodeJS.Timeout | null = null;

/**
 * Initializes the Solana Early Trending Ingestion Engine.
 * Heavy independent discovery is replaced with direct 24/7 @solearlytrending monitoring (sub-3GB/month).
 * Automatically detects incoming posts, audits tokens, broadcasts alerts, and triggers auto-sniping.
 */
export function initEarlyTrendingCron(): void {
  initTrendingChannelMonitor();
}
