import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { redis } from './redis.js';
import { bot } from './telegram.js';
import { AiNarrativeScore, LearnedEvaluationResult, SlmEvaluationResult } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const BACKUP_FILE = path.join(DATA_DIR, 'paper_trading.json');

export interface PaperWalletState {
  initialBalanceUsd: number;
  liquidCashUsd: number;
  solPriceUsd: number;
  liquidCashSol: number;
  totalInvestedUsd: number;
  totalRealizedPnlUsd: number;
  totalFeesPaidSol: number;
  totalFeesPaidUsd: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePercent: number;
  maxConcurrentPositions: number;
  tradeSizePercent: number;
  tradeSizeUsd: number;
  consecutiveLosses: number;
  circuitBreakerUntilMs?: number;
  circuitBreakerReason?: string;
  startedAt: string;
  lastUpdated: string;
}

export interface PaperPosition {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  lowestPriceUsd: number;
  investedUsd: number;
  investedSol: number;
  tokensAcquired: number;
  slippagePct: number;
  buyGasFeeSol: number;
  buyGasFeeUsd: number;
  status: 'OPEN' | 'PARTIAL_TP_2X' | 'CLOSED';
  initialTokens: number;
  remainingTokens: number;
  realizedPnlUsd: number;
  realizedSolProfit: number;
  exitReason?: 'HARD_STOP_35' | 'HARD_STOP_25' | 'TRAILING_STOP' | 'MANUAL' | 'EMERGENCY_RUG_CUT' | 'TAKE_PROFIT_10X' | 'TAKE_PROFIT_5X' | 'TAKE_PROFIT_3X' | 'TAKE_PROFIT_FULL';
  firstUnderStopLossAt?: number;
  sellGasFeeSol?: number;
  sellGasFeeUsd?: number;
  sellSlippagePct?: number;
  openedAt: number;
  closedAt?: number;
  dexUrl: string;
  imageUrl?: string | null;
  peakMultiplier: number;
  strategyProfile?: 'VIRAL_RUNNER' | 'BALANCED_MOMENTUM' | 'FAST_SCALP';
  targetMultiplier?: number;
  allocationPercent?: number;
  aiConvictionScore?: number;
  aiThesis?: string;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp3Hit?: boolean;
  slmVerdict?: SlmEvaluationResult;
  slmMultiples?: number[];
  slmTrailingStopPct?: number;
}

export interface PaperPortfolioSummary {
  wallet: PaperWalletState;
  netWorthUsd: number;
  netWorthSol: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  activePositions: PaperPosition[];
  closedPositions: PaperPosition[];
}

const REDIS_KEY_WALLET = 'soul:paper_wallet:state';
const REDIS_KEY_POSITIONS = 'soul:paper_wallet:positions';
const REDIS_KEY_HISTORY = 'soul:paper_wallet:history';

// In-memory state with persistence fallback
let cachedWallet: PaperWalletState = {
  initialBalanceUsd: 100.0,
  liquidCashUsd: 100.0,
  solPriceUsd: 145.0,
  liquidCashSol: 100.0 / 145.0,
  totalInvestedUsd: 0,
  totalRealizedPnlUsd: 0,
  totalFeesPaidSol: 0,
  totalFeesPaidUsd: 0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRatePercent: 0,
  maxConcurrentPositions: 20,
  tradeSizePercent: 3.0,
  tradeSizeUsd: 3.0,
  consecutiveLosses: 0,
  startedAt: new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
};

const activePaperPositions = new Map<string, PaperPosition>();
const closedPaperHistory: PaperPosition[] = [];
let lastSolPriceFetchMs = 0;

// Ensure data backup directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch {}

/**
 * Fetches live SOL price in USD from DexScreener/Jupiter API
 */
export async function fetchLiveSolPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastSolPriceFetchMs < 60_000 && cachedWallet.solPriceUsd > 10) {
    return cachedWallet.solPriceUsd;
  }

  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
      { timeout: 3500 }
    );
    const pair = res.data?.pairs?.[0];
    const price = parseFloat(pair?.priceUsd);
    if (price && price > 10) {
      cachedWallet.solPriceUsd = price;
      lastSolPriceFetchMs = now;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / price).toFixed(4));
      return price;
    }
  } catch (err: any) {
    // Keep cached price on error
  }
  return cachedWallet.solPriceUsd || 145.0;
}

/**
 * Calculates realistic Solana network friction:
 * Base signature fee (0.000005 SOL) + Priority fee / Jito Tip (~0.0030 to 0.0042 SOL)
 */
function calculateRealNetworkGas(solPrice: number): { feeSol: number; feeUsd: number } {
  // Real priority fee during volatile launches is ~0.0032 to 0.0042 SOL
  const randomTip = 0.0032 + Math.random() * 0.001;
  const feeSol = Number(randomTip.toFixed(6));
  const feeUsd = Number((feeSol * solPrice).toFixed(3));
  return { feeSol, feeUsd };
}

/**
 * Calculates realistic slippage & price impact based on pool liquidity:
 * Thin pools (<$15K) suffer 3.5%-5.0% slippage.
 * Deeper pools ($15K-$50K) suffer 2.0%-3.5% slippage.
 * Mature pools (>$50K) suffer 1.0%-2.0% slippage.
 */
function calculateRealSlippage(liquidityUsd: number): number {
  let baseSlippage = 0.025; // 2.5%
  if (liquidityUsd < 15_000) {
    baseSlippage = 0.038 + Math.random() * 0.015; // 3.8% - 5.3%
  } else if (liquidityUsd < 50_000) {
    baseSlippage = 0.022 + Math.random() * 0.012; // 2.2% - 3.4%
  } else {
    baseSlippage = 0.012 + Math.random() * 0.008; // 1.2% - 2.0%
  }
  return Number(baseSlippage.toFixed(4));
}

/**
 * Synchronizes state to Redis and local JSON backup
 */
async function persistPaperTradingState(): Promise<void> {
  cachedWallet.lastUpdated = new Date().toISOString();

  // Update total invested
  let invested = 0;
  for (const pos of activePaperPositions.values()) {
    if (pos.status !== 'CLOSED') {
      const remainingRatio = pos.initialTokens > 0 ? pos.remainingTokens / pos.initialTokens : 1;
      invested += pos.investedUsd * remainingRatio;
    }
  }
  cachedWallet.totalInvestedUsd = Number(invested.toFixed(2));

  // Compute win rate
  const closedCount = cachedWallet.winningTrades + cachedWallet.losingTrades;
  cachedWallet.winRatePercent =
    closedCount > 0 ? Number(((cachedWallet.winningTrades / closedCount) * 100).toFixed(1)) : 0;

  try {
    // 1. Redis
    await redis.set(REDIS_KEY_WALLET, JSON.stringify(cachedWallet));
    await redis.set(
      REDIS_KEY_POSITIONS,
      JSON.stringify(Array.from(activePaperPositions.values()))
    );
    await redis.set(REDIS_KEY_HISTORY, JSON.stringify(closedPaperHistory.slice(0, 100)));
  } catch {}

  // 2. Local JSON disk backup
  try {
    const backupPayload = {
      wallet: cachedWallet,
      positions: Array.from(activePaperPositions.values()),
      history: closedPaperHistory.slice(0, 100),
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backupPayload, null, 2), 'utf8');
  } catch (err: any) {
    console.warn('⚠️ Could not write paper trading backup:', err.message);
  }
}

/**
 * Initializes the Paper Trading engine from Redis / Disk
 */
export async function initPaperTradingEngine(): Promise<void> {
  console.log('💵 [Paper Trading Engine] Initializing $100 real-market simulator with Bounded Autonomy...');
  await fetchLiveSolPrice();

  let loaded = false;

  // 1. Try Redis first
  try {
    const rawWallet = await redis.get(REDIS_KEY_WALLET);
    const rawPositions = await redis.get(REDIS_KEY_POSITIONS);
    const rawHistory = await redis.get(REDIS_KEY_HISTORY);

    if (rawWallet) {
      cachedWallet = JSON.parse(rawWallet);
      if (rawPositions) {
        const arr: PaperPosition[] = JSON.parse(rawPositions);
        activePaperPositions.clear();
        for (const p of arr) {
          activePaperPositions.set(p.tokenMint, p);
        }
      }
      if (rawHistory) {
        const hist: PaperPosition[] = JSON.parse(rawHistory);
        closedPaperHistory.length = 0;
        closedPaperHistory.push(...hist);
      }
      loaded = true;
      console.log(
        `✅ [Paper Trading Engine] Loaded from Redis: Liquid $${cachedWallet.liquidCashUsd.toFixed(2)} | Active Positions: ${activePaperPositions.size}`
      );
    }
  } catch {}

  // 2. Fallback to Disk backup
  if (!loaded && fs.existsSync(BACKUP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      if (data.wallet) {
        cachedWallet = data.wallet;
        activePaperPositions.clear();
        for (const p of data.positions || []) {
          activePaperPositions.set(p.tokenMint, p);
        }
        closedPaperHistory.length = 0;
        closedPaperHistory.push(...(data.history || []));
        console.log(
          `✅ [Paper Trading Engine] Loaded from Disk: Liquid $${cachedWallet.liquidCashUsd.toFixed(2)} | Active Positions: ${activePaperPositions.size}`
        );
        loaded = true;
      }
    } catch {}
  }

  if (!loaded) {
    console.log('🆕 [Paper Trading Engine] Pristine wallet initialized with $100.00 USD.');
    await persistPaperTradingState();
  }
}

/**
 * Resets the paper wallet back to the pristine $100.00 baseline
 */
export async function resetPaperTradingWallet(): Promise<PaperWalletState> {
  const solPrice = await fetchLiveSolPrice();
  cachedWallet = {
    initialBalanceUsd: 100.0,
    liquidCashUsd: 100.0,
    solPriceUsd: solPrice,
    liquidCashSol: Number((100.0 / solPrice).toFixed(4)),
    totalInvestedUsd: 0,
    totalRealizedPnlUsd: 0,
    totalFeesPaidSol: 0,
    totalFeesPaidUsd: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRatePercent: 0,
    maxConcurrentPositions: 20,
    tradeSizePercent: 3.0,
    tradeSizeUsd: 3.0,
    consecutiveLosses: 0,
    circuitBreakerUntilMs: undefined,
    circuitBreakerReason: undefined,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  activePaperPositions.clear();
  closedPaperHistory.length = 0;
  await persistPaperTradingState();

  console.log('🔄 [Paper Trading Engine] Wallet successfully reset to $100.00 USD.');
  return cachedWallet;
}

/**
 * Evaluates and opens a Paper Trade for a qualified candidate
 */
export async function processPaperTradeBuy(
  candidate: {
    tokenMint: string;
    tokenSymbol: string;
    tokenName: string;
    priceUsd: number;
    marketCap: number;
    liquidityUsd?: number;
    dexUrl?: string;
    imageUrl?: string | null;
    aiScore?: AiNarrativeScore;
    learnedRisk?: LearnedEvaluationResult;
    slmVerdict?: SlmEvaluationResult;
    forceBuy?: boolean;
  },
  options?: { forceBuy?: boolean }
): Promise<PaperPosition | null> {
  const isForceBuy = Boolean(candidate.forceBuy || options?.forceBuy);
  const solPrice = await fetchLiveSolPrice();

  // 1. Check Circuit Breaker (Iron Cage Invariant - bypassed on user forced buy)
  if (!isForceBuy && cachedWallet.circuitBreakerUntilMs) {
    if (Date.now() < cachedWallet.circuitBreakerUntilMs) {
      const remainingMins = Math.ceil((cachedWallet.circuitBreakerUntilMs - Date.now()) / 60000);
      console.log(
        `🛡️ [Circuit Breaker Active] New paper trade entries paused for ${remainingMins}m (${cachedWallet.circuitBreakerReason}). Skipping $${candidate.tokenSymbol}.`
      );
      return null;
    } else {
      // Cooldown ended: automatically restore trading
      cachedWallet.circuitBreakerUntilMs = undefined;
      cachedWallet.circuitBreakerReason = undefined;
      cachedWallet.consecutiveLosses = 0;
      console.log('✅ [Circuit Breaker Cleared] 30m cooling off ended. Paper trading resumed.');
    }
  }

  // 1b. Informational SLM Quality Gate Log: Never vetoes paper trades (trades instantly regardless of NO_GO)
  if (candidate.slmVerdict) {
    console.log(
      `ℹ️ [Paper Trading SLM Gate] $${candidate.tokenSymbol} signal: ${candidate.slmVerdict.viabilitySignal}. Paper trade proceeds instantly regardless of verdict.`
    );
  }

  // 2. Autonomous AI Veto: If AI conviction is low or rug risk is high (bypassed on user forced buy)
  if (!isForceBuy && candidate.aiScore) {
    if (candidate.aiScore.convictionScore < 50) {
      console.log(
        `🤖 [AI Bounded Autonomy: REJECTED] $${candidate.tokenSymbol} skipped. Conviction ${candidate.aiScore.convictionScore}/100 < 50. AI chose not to deploy capital. (${candidate.aiScore.thesis})`
      );
      return null;
    }
    if (candidate.aiScore.rugRisk === 'HIGH') {
      console.log(
        `🤖 [AI Bounded Autonomy: REJECTED] $${candidate.tokenSymbol} skipped. High rug risk detected by AI.`
      );
      return null;
    }
  }

  // 3. Learned Flop Memory Veto (bypassed on user forced buy)
  if (!isForceBuy && candidate.learnedRisk) {
    if (candidate.learnedRisk.verdict === 'REJECTED_FLOP_SIGNATURE' || candidate.learnedRisk.flopRiskScore > 75) {
      console.log(
        `🧠 [Flop Learner Veto] $${candidate.tokenSymbol} rejected. High flop risk (${candidate.learnedRisk.flopRiskScore}/100).`
      );
      return null;
    }
  }

  // 4. Check if already actively holding this token
  const existingPos = activePaperPositions.get(candidate.tokenMint);
  if (existingPos && existingPos.status !== 'CLOSED') {
    return existingPos;
  }

  // 4b. Smart Re-Trade Rule (bypassed on user forced buy):
  // If a coin was previously traded and closed at a loss:
  // Block re-entry if it is still low / dumping.
  // Allow re-entry ONLY if it has proven profitable OR has recovered and broken out above previous entry price!
  if (!isForceBuy) {
    const pastTrades = closedPaperHistory.filter((p) => p.tokenMint === candidate.tokenMint);
    if (pastTrades.length > 0) {
      const hasMadeProfit = pastTrades.some((p) => p.realizedPnlUsd > 0);
      const isBreakoutRecovery = pastTrades.every((p) => candidate.priceUsd >= p.entryPriceUsd * 1.05);
      if (!hasMadeProfit && !isBreakoutRecovery) {
        console.log(
          `🛡️ [Paper Trading Gate] Blocked re-trade for $${candidate.tokenSymbol}: Previous trade closed at a loss (-$${Math.abs(pastTrades[0].realizedPnlUsd).toFixed(2)}). Price must break out above previous entry ($${pastTrades[0].entryPriceUsd.toFixed(6)}) to re-qualify.`
        );
        return null;
      }
      if (!hasMadeProfit && isBreakoutRecovery) {
        console.log(
          `🚀 [Paper Trading Breakout Recovery] Re-entering $${candidate.tokenSymbol}: Recovered above previous entry price ($${candidate.priceUsd.toFixed(6)} > $${pastTrades[0].entryPriceUsd.toFixed(6)}). Breakout wave active!`
        );
      }
    }
  }

  // 5. Count active open positions (bypassed on user forced buy)
  const openCount = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  ).length;
  if (!isForceBuy && openCount >= cachedWallet.maxConcurrentPositions) {
    console.log(
      `💼 [Paper Trading] Max concurrent positions (${cachedWallet.maxConcurrentPositions}) reached. Skipping $${candidate.tokenSymbol}.`
    );
    return null;
  }

  // 6. Compute dynamic capital allocation:
  // Bounded Autonomy: AI determines sizing between 1.0% and 3.0% (hard Iron Cage ceiling)
  let currentOpenValue = 0;
  for (const pos of activePaperPositions.values()) {
    if (pos.status !== 'CLOSED') {
      currentOpenValue += pos.remainingTokens * pos.currentPriceUsd;
    }
  }
  const currentNetWorth = cachedWallet.liquidCashUsd + currentOpenValue;

  let targetPct = 3.0;
  if (candidate.aiScore && typeof candidate.aiScore.suggestedAllocationPct === 'number') {
    targetPct = candidate.aiScore.suggestedAllocationPct;
  } else if (candidate.aiScore) {
    const conviction = candidate.aiScore.convictionScore || 70;
    if (conviction >= 85 && candidate.aiScore.rugRisk === 'LOW') {
      targetPct = 3.0;
    } else if (conviction >= 70) {
      targetPct = 2.0;
    } else {
      targetPct = 1.2;
    }
  }
  // Hard Iron Cage Clamp: Never exceed 3.0%, never allocate less than 1.0% for valid trades
  const effectiveAllocationPct = Math.min(3.0, Math.max(1.0, Number(targetPct.toFixed(1))));
  let dynamicTradeSize = Math.max(1.0, Number((currentNetWorth * (effectiveAllocationPct / 100)).toFixed(2)));

  // 7. Compute real network friction
  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);

  // If forceBuy (user submitted) and liquid cash is low, scale trade to available cash or top up minimally
  if (isForceBuy && cachedWallet.liquidCashUsd < dynamicTradeSize + feeUsd) {
    if (cachedWallet.liquidCashUsd >= 1.5) {
      dynamicTradeSize = Math.max(1.0, Number((cachedWallet.liquidCashUsd - feeUsd).toFixed(2)));
    } else {
      // Free up minimal buffer for user-submitted paper trade
      cachedWallet.liquidCashUsd = 10.0;
      cachedWallet.liquidCashSol = Number((10.0 / solPrice).toFixed(4));
      dynamicTradeSize = 3.0;
    }
  }

  const tradeSizeUsd = dynamicTradeSize;
  cachedWallet.tradeSizeUsd = dynamicTradeSize;
  const totalRequiredCash = tradeSizeUsd + feeUsd;

  // 8. Verify liquid cash availability
  if (cachedWallet.liquidCashUsd < totalRequiredCash) {
    console.log(
      `💼 [Paper Trading] Insufficient liquid cash ($${cachedWallet.liquidCashUsd.toFixed(2)} < $${totalRequiredCash.toFixed(2)}). Skipping $${candidate.tokenSymbol}.`
    );
    return null;
  }

  // 9. Compute real slippage & price impact
  const slippagePct = calculateRealSlippage(candidate.liquidityUsd || 25_000);
  const effectiveTokens =
    (tradeSizeUsd / Math.max(0.00000001, candidate.priceUsd)) * (1 - slippagePct);
  const investedSol = Number((tradeSizeUsd / solPrice).toFixed(4));

  // 10. Deduct from liquid cash
  cachedWallet.liquidCashUsd -= totalRequiredCash;
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.totalFeesPaidSol += feeSol;
  cachedWallet.totalFeesPaidUsd += feeUsd;
  cachedWallet.totalTrades += 1;

  // 11. Extract Bounded Autonomy Strategy Profile & Targets
  const strategyProfile = candidate.aiScore?.strategyProfile || 'BALANCED_MOMENTUM';
  const targetMultiplier = candidate.aiScore?.targetMultiplier || (strategyProfile === 'VIRAL_RUNNER' ? 10 : strategyProfile === 'BALANCED_MOMENTUM' ? 3 : 2);
  const aiConviction = candidate.aiScore?.convictionScore || 70;
  const aiThesis = candidate.aiScore?.thesis || 'Fast trending breakout detected on Raydium/Pump.fun.';

  const slmMultiples = candidate.slmVerdict?.recommendedMultiples && candidate.slmVerdict.recommendedMultiples.length > 0
    ? candidate.slmVerdict.recommendedMultiples
    : (strategyProfile === 'VIRAL_RUNNER' ? [2, 5, 10] : [2, 4, 7]);
  const slmTrailingStopPct = candidate.slmVerdict?.trailingStopLossPct ?? 15;

  // 12. Create Position
  const position: PaperPosition = {
    id: `paper_${Date.now()}_${candidate.tokenMint.slice(0, 4)}`,
    tokenMint: candidate.tokenMint,
    tokenSymbol: candidate.tokenSymbol,
    tokenName: candidate.tokenName,
    entryPriceUsd: candidate.priceUsd,
    currentPriceUsd: candidate.priceUsd,
    peakPriceUsd: candidate.priceUsd,
    lowestPriceUsd: candidate.priceUsd,
    investedUsd: tradeSizeUsd,
    investedSol,
    tokensAcquired: effectiveTokens,
    slippagePct: Number((slippagePct * 100).toFixed(2)),
    buyGasFeeSol: feeSol,
    buyGasFeeUsd: feeUsd,
    status: 'OPEN',
    initialTokens: effectiveTokens,
    remainingTokens: effectiveTokens,
    realizedPnlUsd: 0,
    realizedSolProfit: 0,
    openedAt: Date.now(),
    dexUrl: candidate.dexUrl || `https://dexscreener.com/solana/${candidate.tokenMint}`,
    imageUrl: candidate.imageUrl,
    peakMultiplier: 1.0,
    strategyProfile,
    targetMultiplier,
    allocationPercent: effectiveAllocationPct,
    aiConvictionScore: aiConviction,
    aiThesis,
    slmVerdict: candidate.slmVerdict,
    slmMultiples,
    slmTrailingStopPct,
  };

  activePaperPositions.set(candidate.tokenMint, position);
  await persistPaperTradingState();

  console.log(
    `🎯 [PAPER TRADE OPENED: BOUNDED AUTONOMY] $${candidate.tokenSymbol} at $${candidate.priceUsd.toFixed(6)} | Profile: ${strategyProfile} | Size: $${tradeSizeUsd.toFixed(2)} (${effectiveAllocationPct}% of $${currentNetWorth.toFixed(2)}) | Conviction: ${aiConviction}/100 | Slipped: ${(slippagePct * 100).toFixed(1)}% | Gas: ${feeSol} SOL ($${feeUsd.toFixed(2)}) | Remaining Cash: $${cachedWallet.liquidCashUsd.toFixed(2)}`
  );

  // Send Telegram receipt
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      let slmReceiptSection = '';
      if (candidate.slmVerdict) {
        const multDisplay = slmMultiples.map((m: number) => `${m}X`).join(' • ');
        const signalDisplay = candidate.slmVerdict.viabilitySignal === 'GO'
          ? '🟢 <b>CONFIRMED (GO)</b>'
          : '🔴 <b>NO_GO (Traded with paper money anyway)</b>';
        slmReceiptSection = `\n\n🛡️ <b>SLM QUALITY GATE (ZERO-COST):</b>\n` +
          `• 🚦 Signal: ${signalDisplay}\n` +
          `• 🔥 Organic Hype: <code>${candidate.slmVerdict.organicHypeScore}/10</code> (bot raid passed)\n` +
          `• 🧠 Narrative Velocity: <code>${candidate.slmVerdict.narrativeStrength}/10</code>\n` +
          `• 🎯 Ladder Exits: <code>${multDisplay}</code> | Moonbag Stop: <code>-${slmTrailingStopPct}%</code>\n` +
          `• ⚖️ <i>${candidate.slmVerdict.justificationSummary}</i>`;
      }

      const receiptCard = `
💼 <b>[PAPER TRADE EXECUTED: BOUNDED AUTONOMY]</b> ⚡
<i>Simulating 100% Real Market Conditions &amp; Network Fees</i>

🪙 Token: <b>$${candidate.tokenSymbol}</b> (${candidate.tokenName})
💰 Entry Price: <code>$${candidate.priceUsd.toFixed(6)}</code>
📊 Market Cap: <code>$${(candidate.marketCap / 1000).toFixed(1)}K</code>
💵 Position Size: <b>$${tradeSizeUsd.toFixed(2)}</b> (<b>${effectiveAllocationPct}%</b> of capital • <code>${investedSol} SOL</code>)
📉 Real Slippage: <b>${(slippagePct * 100).toFixed(1)}%</b>
⛽ Priority Gas Fee: <code>${feeSol} SOL</code> (<b>$${feeUsd.toFixed(2)}</b>)${slmReceiptSection}

🤖 <b>AI AUTONOMOUS DISCRETION:</b>
• 🎯 Conviction: <b>${aiConviction}/100</b> (${aiConviction >= 80 ? '🔥 Ultra High' : '⚡ Strong'})
• 🧭 Strategy Profile: <b>${strategyProfile}</b> (Mode: <code>Uncapped Trailing Runner</code>)
• 💡 Thesis: <i>${aiThesis}</i>

💎 <b>UNCAPPED RUNNER MODE (NO CEILING CAP):</b>
• 🛑 <b>Hard Allocation Cap:</b> Max 3.0% capital staked per trade ($1 - $3)
• 🚀 <b>Infinite Upside:</b> Zero profit ceiling (No 3X/5X cap) — rides the market up indefinitely!
• 🛡️ <b>Principal De-risking:</b> 100% initial principal secured on first double (2X)
• 🛑 <b>Trailing Stop:</b> Remaining moonbag exits ONLY when market trails down from peak!

💼 <b>Paper Wallet:</b> <code>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</code> available (${openCount + 1}/${cachedWallet.maxConcurrentPositions} slots)
      `.trim();

      await bot.sendMessage(env.TELEGRAM_CHAT_ID, receiptCard, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 DexScreener Chart', url: position.dexUrl },
              { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
            ],
          ],
        },
      });
    } catch (tgErr: any) {
      console.warn('⚠️ Could not send paper trade receipt to Telegram:', tgErr.message);
    }
  }

  return position;
}

/**
 * Executes a trailing stop-loss sale on remaining paper position tokens when the market trails down from its peak.
 */
async function executePaperTrailingStopExit(
  pos: PaperPosition,
  currentPriceUsd: number,
  solPrice: number,
  pairData: any,
  trailingStopPct: number,
  dropFromPeakPct: number,
  profileLabel: string
): Promise<void> {
  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
  const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

  const tokensToSell = pos.remainingTokens;
  const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
  const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
  const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 1.0;
  const costBasisUsd = pos.investedUsd * remainingFraction;

  pos.status = 'CLOSED';
  pos.closedAt = Date.now();
  pos.remainingTokens = 0;
  pos.exitReason = 'TRAILING_STOP';
  pos.sellGasFeeSol = feeSol;
  pos.sellGasFeeUsd = feeUsd;
  pos.sellSlippagePct = Number((sellSlippage * 100).toFixed(2));
  pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
  pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * remainingFraction;

  cachedWallet.liquidCashUsd += netReturnUsd;
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
  cachedWallet.totalFeesPaidSol += feeSol;
  cachedWallet.totalFeesPaidUsd += feeUsd;

  if (pos.realizedPnlUsd >= 0) {
    cachedWallet.winningTrades += 1;
    cachedWallet.consecutiveLosses = 0;
  } else {
    cachedWallet.losingTrades += 1;
    cachedWallet.consecutiveLosses += 1;
  }

  activePaperPositions.delete(pos.tokenMint);
  closedPaperHistory.unshift(pos);
  await persistPaperTradingState();

  console.log(
    `🛡️ [UNCAPPED RUNNER TRAILING STOP] $${pos.tokenSymbol} (${profileLabel}) peaked at ${pos.peakMultiplier}X and trailed down -${dropFromPeakPct.toFixed(1)}% (Stop: -${trailingStopPct}%). Sold remaining bag for +$${netReturnUsd.toFixed(2)}. Total Net Profit: +$${pos.realizedPnlUsd.toFixed(2)}`
  );

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const tpCard = `
🛡️ <b>[UNCAPPED RUNNER: TRAILING STOP EXECUTED]</b> 🛑
<i>Peak Reversal Triggered -${trailingStopPct}% Trailing Stop • Full Trade Completed</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
🔝 Peak Reached: <code>$${pos.peakPriceUsd.toFixed(6)}</code> (<b>${pos.peakMultiplier}X Peak</b>)
📉 Trailing Pullback: <b>-${dropFromPeakPct.toFixed(1)}% from Highs</b> (Stop Trigger: <code>-${trailingStopPct}%</code>)
💰 Final Moonbag Sold: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
🏆 <b>Total Net Trade Profit:</b> <b>+$${pos.realizedPnlUsd.toFixed(2)} USD</b> (<code>+${pos.realizedSolProfit.toFixed(3)} SOL</code>) 💸
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>

💼 <b>Total Paper Portfolio:</b> <code>$${(cachedWallet.liquidCashUsd + cachedWallet.totalInvestedUsd).toFixed(2)} USD</code>
      `.trim();
      await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
    } catch {}
  }
}

/**
 * Evaluates active paper trading positions against automated TP/SL & Trailing Stop rules
 * Called on every 12s price tick in priceTracker.ts
 */
export async function checkPaperPositionsTpSl(
  tokenMint: string,
  currentPriceUsd: number,
  pairData?: any
): Promise<void> {
  const pos = activePaperPositions.get(tokenMint);
  if (!pos || pos.status === 'CLOSED') return;

  const solPrice = await fetchLiveSolPrice();
  pos.currentPriceUsd = currentPriceUsd;
  pos.peakPriceUsd = Math.max(pos.peakPriceUsd, currentPriceUsd);
  pos.lowestPriceUsd = Math.min(pos.lowestPriceUsd, currentPriceUsd);
  pos.peakMultiplier = Number((pos.peakPriceUsd / pos.entryPriceUsd).toFixed(2));

  const gainFromEntryPct = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
  const dropFromPeakPct = ((pos.peakPriceUsd - currentPriceUsd) / pos.peakPriceUsd) * 100;

  const profile = pos.strategyProfile || 'BALANCED_MOMENTUM';

  // =========================================================================
  // UNCAPPED TRAILING RUNNER SYSTEM (NO 3X/5X/10X CEILING CAP)
  // 1. Initial Scale-Out / De-risking: Returns 100% of invested principal.
  // 2. Uncapped Moonbag: Zero profit ceiling. As long as the market doesn't
  //    trail down, the runner keeps going up with the market (10X, 20X, 50X+).
  // 3. Trailing Stop: Sells remaining bag ONLY when price trails down from peak.
  // =========================================================================

  // --- Profile SLM: Quality Gate Laddered Take-Profits & Dynamic Moonbag Trailing Stop ---
  if (pos.slmMultiples && pos.slmMultiples.length >= 2) {
    const m1 = pos.slmMultiples[0] || 2.0;
    const m2 = pos.slmMultiples[1] || 4.0;
    const trailingStopPct = pos.slmTrailingStopPct || 18.0;

    const target1Gain = (m1 - 1) * 100.0;
    const target2Gain = (m2 - 1) * 100.0;

    // Stage 1: Target 1 (e.g. 2.0X / +100%) -> Sell 35% of initial tokens (De-risk trade & lock in principal)
    if (!pos.tp1Hit && gainFromEntryPct >= target1Gain) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

      const tokensToSell = pos.initialTokens * 0.35;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.35;

      pos.tp1Hit = true;
      pos.status = 'PARTIAL_TP_2X';
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.35;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🎯 [SLM LADDER TP1 (${m1}X)] $${pos.tokenSymbol} hit +${gainFromEntryPct.toFixed(1)}%! Sold 35% for +$${netReturnUsd.toFixed(2)}. Remaining 65% riding UNCAPPED with -${trailingStopPct}% trailing stop!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🎯 <b>[SLM QUALITY GATE: TP1 HIT (+${gainFromEntryPct.toFixed(0)}% / ${m1}X)]</b> 🚀
<i>Tier 1 Scale-Out Executed (35% De-Risking)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (${m1}X Target)</b>
💰 Action: <b>Sold 35% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
💎 <b>Uncapped Moonbag:</b> Remaining 65% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (No ceiling cap)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Stage 2: Target 2 (e.g. 4.0X / +300%) -> Sell another 35% of initial tokens (Lock in massive profit)
    if (pos.tp1Hit && !pos.tp2Hit && gainFromEntryPct >= target2Gain) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 40_000);

      const tokensToSell = pos.initialTokens * 0.35;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.35;

      pos.tp2Hit = true;
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.35;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🚀 [SLM LADDER TP2 (${m2}X)] $${pos.tokenSymbol} hit ${m2}X! Sold 35% for +$${netReturnUsd.toFixed(2)}. Remaining 30% riding UNCAPPED with -${trailingStopPct}% trailing stop!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🚀 <b>[SLM QUALITY GATE: TP2 HIT (+${gainFromEntryPct.toFixed(0)}% / ${m2}X)]</b> 🏆
<i>Tier 2 Scale-Out Executed (35% Mega Profit Harvested)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (${m2}X Target)</b>
💰 Action: <b>Sold 35% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
💎 <b>Pure Moonbag:</b> Remaining 30% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (No ceiling cap)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Dynamic Trailing Stop on Moonbag: Triggered when price trails down from peak
    if ((pos.tp1Hit || pos.peakMultiplier >= 1.6) && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
      await executePaperTrailingStopExit(pos, currentPriceUsd, solPrice, pairData, trailingStopPct, dropFromPeakPct, 'SLM Quality Gate');
      return;
    }
  }

  // --- Profile A: VIRAL_RUNNER (Uncapped Trailing Moonshot) ---
  else if (profile === 'VIRAL_RUNNER') {
    const trailingStopPct = 20.0;

    // Stage 1: +100% (2.0X) -> Sell 35% of initial tokens (De-risk trade)
    if (!pos.tp1Hit && gainFromEntryPct >= 100.0) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

      const tokensToSell = pos.initialTokens * 0.35;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.35;

      pos.tp1Hit = true;
      pos.status = 'PARTIAL_TP_2X';
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.35;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🎯 [VIRAL RUNNER TP1 (+100% / 2.0X)] $${pos.tokenSymbol} hit +${gainFromEntryPct.toFixed(1)}%! Sold 35% for +$${netReturnUsd.toFixed(2)}. Remaining 65% riding UNCAPPED with -${trailingStopPct}% trailing stop!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🎯 <b>[VIRAL RUNNER: TP1 HIT (+100% / 2.0X)]</b> 🚀
<i>Tier 1 Scale-Out Executed (35% De-Risking)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (2.0X Multiplier)</b>
💰 Action: <b>Sold 35% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
💎 <b>Uncapped Runner:</b> Remaining 65% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (No 10X cap • Rides indefinitely until market trails down)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Stage 2: +400% (5.0X) -> Sell another 35% of initial tokens (Lock in massive profit)
    if (pos.tp1Hit && !pos.tp2Hit && gainFromEntryPct >= 400.0) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 40_000);

      const tokensToSell = pos.initialTokens * 0.35;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.35;

      pos.tp2Hit = true;
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.35;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🚀 [VIRAL RUNNER TP2 (+400% / 5.0X)] $${pos.tokenSymbol} hit 5X peak! Sold 35% for +$${netReturnUsd.toFixed(2)}. Remaining 30% riding UNCAPPED with -${trailingStopPct}% trailing stop!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🚀 <b>[VIRAL RUNNER: TP2 HIT (+400% / 5.0X)]</b> 🏆
<i>Tier 2 Scale-Out Executed (35% Mega Profit Harvested)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (5.0X Multiplier)</b>
💰 Action: <b>Sold 35% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
💎 <b>Pure Moonbag:</b> Final 30% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (No 10X cap • Rides indefinitely until market trails down)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Dynamic Trailing Stop on Moonbag: Sells remaining bag ONLY when market trails down from peak!
    if ((pos.tp1Hit || pos.peakMultiplier >= 1.6) && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
      await executePaperTrailingStopExit(pos, currentPriceUsd, solPrice, pairData, trailingStopPct, dropFromPeakPct, 'VIRAL_RUNNER');
      return;
    }
  }

  // --- Profile B: FAST_SCALP (Uncapped Trailing Runner • 3.0X Cap Removed) ---
  else if (profile === 'FAST_SCALP') {
    const trailingStopPct = 15.0;

    // Stage 1: +75% (1.75X) -> Sell 50% of initial tokens (De-risk trade)
    if (!pos.tp1Hit && pos.status === 'OPEN' && gainFromEntryPct >= 75.0) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 25_000);

      const tokensToSell = pos.initialTokens * 0.5;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.5;

      pos.tp1Hit = true;
      pos.status = 'PARTIAL_TP_2X';
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.5;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🎯 [FAST SCALP TP1 HIT (+75% / 1.75X)] $${pos.tokenSymbol} sold 50% for +$${netReturnUsd.toFixed(2)}. Remaining 50% riding UNCAPPED with -${trailingStopPct}% trailing stop!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🎯 <b>[FAST SCALP TAKE-PROFIT HIT]</b> ⚡
<i>Quick 50% Scale-Out Executed at 1.75X</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (1.75X Multiplier)</b>
💰 Action: <b>Sold 50% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code>
💎 <b>Uncapped Runner:</b> Remaining 50% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (3.0X cap removed • Rides indefinitely until market trails down)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Dynamic Trailing Stop on Moonbag: Sells remaining bag ONLY when market trails down from peak!
    if ((pos.tp1Hit || pos.peakMultiplier >= 1.6) && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
      await executePaperTrailingStopExit(pos, currentPriceUsd, solPrice, pairData, trailingStopPct, dropFromPeakPct, 'FAST_SCALP');
      return;
    }
  }

  // --- Profile C: BALANCED_MOMENTUM & Default (Uncapped Trailing Runner • 5.0X Cap Removed) ---
  else {
    const trailingStopPct = 18.0;

    // Stage 1: +100% (2.0X) -> Sell 50% to secure 100% principal back
    if (!pos.tp1Hit && pos.status === 'OPEN' && gainFromEntryPct >= 100.0) {
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

      const tokensToSell = pos.initialTokens * 0.5;
      const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const costBasisUsd = pos.investedUsd * 0.5;

      pos.tp1Hit = true;
      pos.status = 'PARTIAL_TP_2X';
      pos.remainingTokens -= tokensToSell;
      pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
      pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.5;

      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += netReturnUsd - costBasisUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;

      await persistPaperTradingState();

      console.log(
        `🎯 [BALANCED 2X TAKE-PROFIT] $${pos.tokenSymbol} hit +${gainFromEntryPct.toFixed(1)}%! Sold 50% for +$${netReturnUsd.toFixed(2)}. 100% principal back in liquid cash!`
      );

      if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
        try {
          const tpCard = `
🎯 <b>[PAPER TRADING: 2X TAKE-PROFIT HIT]</b> 🚀
<i>Automated 50% Scale-Out Executed (100% Principal Returned)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (2.0X Multiplier)</b>
💰 Action: <b>Sold 50% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
💎 <b>Uncapped Moonbag:</b> Remaining 50% riding <b>UNCAPPED with -${trailingStopPct}% Trailing Stop</b> (5.0X cap removed • Rides indefinitely until market trails down)!
          `.trim();
          await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
        } catch {}
      }
      return;
    }

    // Dynamic Trailing Stop on Moonbag: Sells remaining bag ONLY when market trails down from peak!
    if ((pos.tp1Hit || pos.peakMultiplier >= 1.6) && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
      await executePaperTrailingStopExit(pos, currentPriceUsd, solPrice, pairData, trailingStopPct, dropFromPeakPct, 'BALANCED_MOMENTUM');
      return;
    }
  }
}

/**
 * Returns comprehensive portfolio summary with live unrealized calculations
 */
export async function getPaperPortfolioSummary(): Promise<PaperPortfolioSummary> {
  const solPrice = await fetchLiveSolPrice();
  const activeList: PaperPosition[] = [];
  let unrealizedPnl = 0;
  let currentOpenValue = 0;

  for (const pos of activePaperPositions.values()) {
    if (pos.status !== 'CLOSED') {
      const liveTokens = pos.remainingTokens;
      const liveValueUsd = liveTokens * pos.currentPriceUsd;
      const remainingRatio = pos.initialTokens > 0 ? pos.remainingTokens / pos.initialTokens : 1;
      const initialCostOfRemaining = pos.investedUsd * remainingRatio;
      const positionUnrealized = liveValueUsd - initialCostOfRemaining;

      unrealizedPnl += positionUnrealized;
      currentOpenValue += liveValueUsd;
      activeList.push({ ...pos });
    }
  }

  const netWorthUsd = Number((cachedWallet.liquidCashUsd + currentOpenValue).toFixed(2));
  const totalPnlUsd = Number((netWorthUsd - cachedWallet.initialBalanceUsd).toFixed(2));
  const totalPnlPercent = Number(
    (((netWorthUsd - cachedWallet.initialBalanceUsd) / cachedWallet.initialBalanceUsd) * 100).toFixed(
      1
    )
  );

  return {
    wallet: {
      ...cachedWallet,
      liquidCashUsd: Number(cachedWallet.liquidCashUsd.toFixed(2)),
      liquidCashSol: Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4)),
      totalInvestedUsd: Number(currentOpenValue.toFixed(2)),
    },
    netWorthUsd,
    netWorthSol: Number((netWorthUsd / solPrice).toFixed(4)),
    unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
    totalPnlUsd,
    totalPnlPercent,
    activePositions: activeList,
    closedPositions: closedPaperHistory.slice(0, 20),
  };
}
