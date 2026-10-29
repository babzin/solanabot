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

function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
  autoRefillCount: number;
  totalRefilledUsd: number;
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
  autoRefillCount: number;
  totalRefilledUsd: number;
  activePositions: PaperPosition[];
  closedPositions: PaperPosition[];
}

const REDIS_KEY_WALLET = 'soul:paper_wallet:state';
const REDIS_KEY_POSITIONS = 'soul:paper_wallet:positions';
const REDIS_KEY_HISTORY = 'soul:paper_wallet:history';

export const PAPER_RESERVE_FLOOR_USD = 200.0;
export const PAPER_TARGET_BALANCE_USD = 1000.0;
export const MAX_PAPER_TRADE_SIZE_USD = 10.0; // Strictly max $10.00 USD per trade (1% of $1,000 funds)
let lastReserveAlertTimeMs = 0;

// In-memory state with persistence fallback
let cachedWallet: PaperWalletState = {
  initialBalanceUsd: 1000.0,
  liquidCashUsd: 1000.0,
  solPriceUsd: 145.0,
  liquidCashSol: 1000.0 / 145.0,
  totalInvestedUsd: 0,
  totalRealizedPnlUsd: 0,
  totalFeesPaidSol: 0,
  totalFeesPaidUsd: 0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRatePercent: 0,
  maxConcurrentPositions: 200,
  tradeSizePercent: 1.0,
  tradeSizeUsd: 10.0,
  consecutiveLosses: 0,
  autoRefillCount: 0,
  totalRefilledUsd: 0,
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
  console.log('💵 [Paper Trading Engine] Initializing $1,000 real-market simulator with Bounded Autonomy...');
  await fetchLiveSolPrice();

  let loaded = false;

  // 1. Try Redis first
  try {
    const rawWallet = await redis.get(REDIS_KEY_WALLET);
    const rawPositions = await redis.get(REDIS_KEY_POSITIONS);
    const rawHistory = await redis.get(REDIS_KEY_HISTORY);

    if (rawWallet) {
      cachedWallet = JSON.parse(rawWallet);
      cachedWallet.autoRefillCount = cachedWallet.autoRefillCount || 0;
      cachedWallet.totalRefilledUsd = cachedWallet.totalRefilledUsd || 0;
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
        `✅ [Paper Trading Engine] Loaded from Redis: Liquid $${cachedWallet.liquidCashUsd.toFixed(2)} | Active Positions: ${activePaperPositions.size} | Refills: ${cachedWallet.autoRefillCount}x`
      );
    }
  } catch {}

  // 2. Fallback to Disk backup
  if (!loaded && fs.existsSync(BACKUP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      if (data.wallet) {
        cachedWallet = data.wallet;
        cachedWallet.autoRefillCount = cachedWallet.autoRefillCount || 0;
        cachedWallet.totalRefilledUsd = cachedWallet.totalRefilledUsd || 0;
        activePaperPositions.clear();
        for (const p of data.positions || []) {
          activePaperPositions.set(p.tokenMint, p);
        }
        closedPaperHistory.length = 0;
        closedPaperHistory.push(...(data.history || []));
        console.log(
          `✅ [Paper Trading Engine] Loaded from Disk: Liquid $${cachedWallet.liquidCashUsd.toFixed(2)} | Active Positions: ${activePaperPositions.size} | Refills: ${cachedWallet.autoRefillCount}x`
        );
        loaded = true;
      }
    } catch {}
  }

  if (!loaded) {
    console.log('🆕 [Paper Trading Engine] Pristine wallet initialized with $1,000.00 USD.');
    await persistPaperTradingState();
  }
}

/**
 * Resets the paper wallet back to the pristine $1,000.00 baseline
 */
export async function resetPaperTradingWallet(): Promise<PaperWalletState> {
  const solPrice = await fetchLiveSolPrice();
  cachedWallet = {
    initialBalanceUsd: 1000.0,
    liquidCashUsd: 1000.0,
    solPriceUsd: solPrice,
    liquidCashSol: Number((1000.0 / solPrice).toFixed(4)),
    totalInvestedUsd: 0,
    totalRealizedPnlUsd: 0,
    totalFeesPaidSol: 0,
    totalFeesPaidUsd: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRatePercent: 0,
    maxConcurrentPositions: 200,
    tradeSizePercent: 1.0,
    tradeSizeUsd: 10.0,
    consecutiveLosses: 0,
    circuitBreakerUntilMs: undefined,
    circuitBreakerReason: undefined,
    autoRefillCount: 0,
    totalRefilledUsd: 0,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  activePaperPositions.clear();
  closedPaperHistory.length = 0;
  await persistPaperTradingState();

  console.log('🔄 [Paper Trading Engine] Wallet successfully reset to $1,000.00 USD.');
  return cachedWallet;
}

/**
 * Adds cash to the paper trading wallet balance without wiping existing trades or history
 */
export async function topUpPaperTradingWallet(amountUsd: number = 1000.0): Promise<PaperWalletState> {
  const solPrice = cachedWallet.solPriceUsd || (await fetchLiveSolPrice());
  cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + amountUsd).toFixed(2));
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.totalRefilledUsd = Number(((cachedWallet.totalRefilledUsd || 0) + amountUsd).toFixed(2));
  cachedWallet.autoRefillCount = (cachedWallet.autoRefillCount || 0) + 1;
  cachedWallet.lastUpdated = new Date().toISOString();
  await persistPaperTradingState();

  console.log(`💵 [Paper Trading Engine] Wallet topped up with +$${amountUsd.toFixed(2)} USD -> New Cash: $${cachedWallet.liquidCashUsd.toFixed(2)} USD`);
  return cachedWallet;
}

/**
 * Throttled alert for Telegram when liquid cash reaches the $200 reserve floor
 * and pauses new trade entries to wait for active position profits.
 */
function maybeSendReserveAlert(currentCash: number, activePositionsCount: number): void {
  const now = Date.now();
  if (now - lastReserveAlertTimeMs < 5 * 60 * 1000) {
    return; // 5-minute cooldown to prevent spam
  }
  lastReserveAlertTimeMs = now;

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const lockAlert = `
⏸️ <b>CAPITAL RESERVE LOCK ($200 FLOOR)</b>
🛡️ Cash at <code>$${currentCash.toFixed(2)} USD</code> • Entries paused to protect capital.
⏳ <b>${activePositionsCount} active trend(s) running.</b> New entries resume on profit!
      `.trim();
      bot.sendMessage(env.TELEGRAM_CHAT_ID, lockAlert, { parse_mode: 'HTML' }).catch(() => {});
    } catch {}
  }
}

/**
 * Automatically tops up paper wallet back to $1,000.00 ONLY when:
 * 1. Liquid cash is at or below the $200.00 reserve floor (or insufficient to trade above $200)
 * 2. There is NO PROFIT AT ALL to wait for (i.e. zero active open positions remaining)
 *
 * Adds money to the existing balance (e.g. existing $200.00 + $800.00 = $1,000.00).
 * Increments autoRefillCount and records totalRefilledUsd.
 */
export async function checkAndRefillIfNoProfit(
  triggerContext: string,
  candidateSymbol?: string
): Promise<boolean> {
  // If liquid cash is comfortably above $200 floor, no refill needed
  if (cachedWallet.liquidCashUsd > PAPER_RESERVE_FLOOR_USD) {
    return false;
  }

  // Count active open positions
  const openPositions = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  );

  // If there are open positions, we MUST wait for profit to enter! Do NOT refill yet!
  if (openPositions.length > 0) {
    return false;
  }

  // "only when theres no profit at all then can it add money to the existing one to take our paper money back to $1,000"
  const topUpAmount = Number(
    Math.max(0, PAPER_TARGET_BALANCE_USD - cachedWallet.liquidCashUsd).toFixed(2)
  );
  if (topUpAmount <= 0) return false;

  const solPrice = cachedWallet.solPriceUsd || (await fetchLiveSolPrice());
  const previousCash = cachedWallet.liquidCashUsd;

  cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + topUpAmount).toFixed(2));
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.autoRefillCount = (cachedWallet.autoRefillCount || 0) + 1;
  cachedWallet.totalRefilledUsd = Number(
    ((cachedWallet.totalRefilledUsd || 0) + topUpAmount).toFixed(2)
  );
  cachedWallet.lastUpdated = new Date().toISOString();

  await persistPaperTradingState();

  console.log(
    `💵 [PAPER MONEY AUTO-REFILL #${cachedWallet.autoRefillCount}] Zero active positions remaining & balance reached $200 floor. Added +$${topUpAmount.toFixed(2)} USD -> Restored to $${PAPER_TARGET_BALANCE_USD.toFixed(2)} USD`
  );

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const safeSym = candidateSymbol ? escapeHtml(candidateSymbol) : '';
      const refillAlert = `
🔄 <b>CAPITAL RESTORED ($1,000 BASELINE)</b>
💰 Cash: <b>$${PAPER_TARGET_BALANCE_USD.toFixed(2)} USD</b> (<code>+$${topUpAmount.toFixed(2)} added</code>)
🎯 Context: Zero active trades remaining${safeSym ? ` • Ready for <b>$${safeSym}</b>` : ''}
      `.trim();

      bot.sendMessage(env.TELEGRAM_CHAT_ID, refillAlert, { parse_mode: 'HTML' }).catch(() => {});
    } catch (tgErr: any) {
      console.warn('⚠️ Could not dispatch paper refill alert to Telegram:', tgErr.message);
    }
  }

  return true;
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

  // 1. Informational Circuit Breaker Log (never blocks paper trades)
  if (cachedWallet.circuitBreakerUntilMs && Date.now() < cachedWallet.circuitBreakerUntilMs) {
    const remainingMins = Math.ceil((cachedWallet.circuitBreakerUntilMs - Date.now()) / 60000);
    console.log(
      `ℹ️ [Circuit Breaker Note] Real-snipe cooldown active (${remainingMins}m remaining). Paper trading continues unconditionally entering every coin.`
    );
  }

  // 1b. Informational SLM Quality Gate Log (never vetoes paper trades)
  if (candidate.slmVerdict) {
    console.log(
      `ℹ️ [Paper Trading SLM Gate] $${candidate.tokenSymbol} signal: ${candidate.slmVerdict.viabilitySignal}. Paper trade entering immediately.`
    );
  }

  // 2. Informational AI Evaluation Log (never vetoes paper trades - enters every coin provided by AI)
  if (candidate.aiScore) {
    console.log(
      `🤖 [AI Evaluation] $${candidate.tokenSymbol}: Conviction ${candidate.aiScore.convictionScore}/100 | Risk: ${candidate.aiScore.rugRisk} | Profile: ${candidate.aiScore.strategyProfile}. Paper trade entering immediately.`
    );
  }

  // 3. Informational Learned Flop Risk Log (never vetoes paper trades)
  if (candidate.learnedRisk) {
    console.log(
      `🧠 [Flop Learner Note] $${candidate.tokenSymbol}: Flop risk score ${candidate.learnedRisk.flopRiskScore}/100. Paper trade tracking live performance.`
    );
  }

  // 4. Check if already actively holding this token (prevent duplicate simultaneous buys of same mint)
  const existingPos = activePaperPositions.get(candidate.tokenMint);
  if (existingPos && existingPos.status !== 'CLOSED') {
    return existingPos;
  }

  // 5. Count active open positions
  const openCount = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  ).length;

  // 6. Compute capital allocation:
  // User Rule: "the amount used to trade shouldn't be more than $10.00 (charges per trade can be added to the trade size)"
  let currentOpenValue = 0;
  for (const pos of activePaperPositions.values()) {
    if (pos.status !== 'CLOSED') {
      currentOpenValue += pos.remainingTokens * pos.currentPriceUsd;
    }
  }
  const currentNetWorth = cachedWallet.liquidCashUsd + currentOpenValue;

  // The base trade amount used to buy tokens is strictly capped at $10.00 USD
  let dynamicTradeSize = MAX_PAPER_TRADE_SIZE_USD;
  const effectiveAllocationPct = Number(((dynamicTradeSize / Math.max(1, currentNetWorth)) * 100).toFixed(1));

  // 7. Compute real network friction (charges per trade added to the trade size)
  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);

  // 8. $200 Safety Reserve Floor & Conditional Refill Engine:
  // User Rule:
  // "if our money should reach $200 the system shouldn't remove money to trade again
  // and it should wait till profit enters, only when theres no profit at all then
  // can it add money to the existing one to take our paper money back to $1,000"
  let didAutoRefill = false;
  let refilledAmount = 0;
  const minRequiredCash = dynamicTradeSize + feeUsd;
  const cashAboveReserve = cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD;

  // Check if liquid cash has reached the $200 floor, or cannot fund the trade + charges without breaching $200
  if (cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD || cashAboveReserve < minRequiredCash) {
    const activeOpenPositions = Array.from(activePaperPositions.values()).filter(
      (p) => p.status !== 'CLOSED'
    );
    const activeCount = activeOpenPositions.length;

    if (activeCount > 0) {
      // Rule Part 1: Money has reached $200 -> System MUST NOT remove money to trade again, and MUST wait till profit enters!
      console.log(
        `⏸️ [Paper Reserve Lock: $200.00 Floor] Liquid cash is $${cachedWallet.liquidCashUsd.toFixed(2)} USD (<= $200.00 floor). New trade entries locked to preserve $200 capital. Waiting for profit to enter from ${activeCount} active position(s)...`
      );
      maybeSendReserveAlert(cachedWallet.liquidCashUsd, activeCount);
      return null;
    } else {
      // Rule Part 2: "only when theres no profit at all then can it add money to the existing one to take our paper money back to $1,000"
      // Zero active positions left. No profit can enter from existing trades. Refill back to $1,000.00!
      const preRefillCash = cachedWallet.liquidCashUsd;
      const refilled = await checkAndRefillIfNoProfit(`Depletion with 0 active positions remaining`, candidate.tokenSymbol);
      if (refilled) {
        didAutoRefill = true;
        refilledAmount = Number((cachedWallet.liquidCashUsd - preRefillCash).toFixed(2));
      }
    }
  }

  // Ensure dynamicTradeSize does NOT dip into the $200 reserve floor
  const safeCashBudget = Math.max(0, cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD - feeUsd);
  if (safeCashBudget < dynamicTradeSize) {
    const activeOpenPositions = Array.from(activePaperPositions.values()).filter(
      (p) => p.status !== 'CLOSED'
    );
    if (activeOpenPositions.length > 0) {
      console.log(
        `⏸️ [Paper Reserve Lock: $200.00 Floor] Liquid cash is $${cachedWallet.liquidCashUsd.toFixed(2)} USD. Available above reserve ($${safeCashBudget.toFixed(2)}) is below trade budget. Waiting for profit to enter from ${activeOpenPositions.length} active position(s)...`
      );
      maybeSendReserveAlert(cachedWallet.liquidCashUsd, activeOpenPositions.length);
      return null;
    } else {
      const preRefillCash = cachedWallet.liquidCashUsd;
      const refilled = await checkAndRefillIfNoProfit(`Zero active positions and available cash < trade budget`, candidate.tokenSymbol);
      if (refilled) {
        didAutoRefill = true;
        refilledAmount = Number((cachedWallet.liquidCashUsd - preRefillCash).toFixed(2));
      }
    }
  }

  if (didAutoRefill) {
    dynamicTradeSize = MAX_PAPER_TRADE_SIZE_USD;
  }

  // Strictly clamp trade size to not exceed $10.00 USD, with safe budget cap
  const maxAllowedTradeSize = Math.max(0.1, Number((cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD - feeUsd).toFixed(2)));
  dynamicTradeSize = Math.min(MAX_PAPER_TRADE_SIZE_USD, maxAllowedTradeSize);
  const tradeSizeUsd = dynamicTradeSize;
  cachedWallet.tradeSizeUsd = dynamicTradeSize;
  const effectiveCashDeduction = tradeSizeUsd + feeUsd;

  // 9. Compute real slippage & price impact
  const slippagePct = calculateRealSlippage(candidate.liquidityUsd || 25_000);
  const effectiveTokens =
    (tradeSizeUsd / Math.max(0.00000001, candidate.priceUsd)) * (1 - slippagePct);
  const investedSol = Number((tradeSizeUsd / solPrice).toFixed(4));

  // 10. Deduct from liquid cash
  const cashToDeduct = tradeSizeUsd + feeUsd;
  cachedWallet.liquidCashUsd = Math.max(0, cachedWallet.liquidCashUsd - cashToDeduct);
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
      const safeSymbol = escapeHtml(candidate.tokenSymbol);
      const mcapText = candidate.marketCap >= 1_000_000
        ? `$${(candidate.marketCap / 1_000_000).toFixed(2)}M`
        : `$${Math.round(candidate.marketCap / 1000)}K`;

      const receiptCard = `
🟢 <b>BOUGHT | $${safeSymbol}</b>
💰 Price: <code>$${candidate.priceUsd.toFixed(6)}</code> • MCap: <b>${mcapText}</b>
💵 Capital: <b>$${tradeSizeUsd.toFixed(2)}</b> (Gas: <b>$${feeUsd.toFixed(2)}</b>)
🎯 Plan: <b>Trend Rider (2X de-risk ➔ Moonbag)</b>
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
      `.trim();

      await bot.sendMessage(env.TELEGRAM_CHAT_ID, receiptCard, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 DexScreener Chart', url: position.dexUrl },
              { text: `🔴 Exit $${position.tokenSymbol}`, callback_data: `cmd_exit_single_${position.tokenMint}` },
            ],
            [
              { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
              { text: '🚨 Exit All Trades', callback_data: 'cmd_exit_all' },
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

  // User Rule: "only when theres no profit at all then can it add money to the exsisting one to take our paper money back to $100"
  const remainingActive = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  ).length;
  if (remainingActive === 0 && cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD) {
    await checkAndRefillIfNoProfit('Last Active Position Concluded via Trailing Stop - Zero Profit Remaining');
  }

  console.log(
    `🛡️ [UNCAPPED RUNNER TRAILING STOP] $${pos.tokenSymbol} (${profileLabel}) peaked at ${pos.peakMultiplier}X and trailed down -${dropFromPeakPct.toFixed(1)}% (Stop: -${trailingStopPct}%). Sold remaining bag for +$${netReturnUsd.toFixed(2)}. Total Net Profit: +$${pos.realizedPnlUsd.toFixed(2)}`
  );

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const pnlSign = pos.realizedPnlUsd >= 0 ? '+' : '';
      const tpCard = `
🛑 <b>TREND EXIT | $${pos.tokenSymbol}</b>
🔝 Peak: <b>${pos.peakMultiplier}X</b> (Trailed -${dropFromPeakPct.toFixed(0)}%)
💵 Net Profit: <b>${pnlSign}$${pos.realizedPnlUsd.toFixed(2)} USD</b>
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
      `.trim();
      await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
    } catch {}
  }
}

/**
 * Executes an emergency capital-protection stop-loss sale when an un-profited token suffers sustained breakdown or rug dump.
 */
async function executePaperStopLossExit(
  pos: PaperPosition,
  currentPriceUsd: number,
  solPrice: number,
  pairData: any,
  gainFromEntryPct: number,
  isEmergencyRug: boolean
): Promise<void> {
  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
  const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 20_000);

  const tokensToSell = pos.remainingTokens;
  const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
  const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
  const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 1.0;
  const costBasisUsd = pos.investedUsd * remainingFraction;

  pos.status = 'CLOSED';
  pos.closedAt = Date.now();
  pos.remainingTokens = 0;
  pos.exitReason = isEmergencyRug ? 'EMERGENCY_RUG_CUT' : 'HARD_STOP_35';
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
  cachedWallet.losingTrades += 1;
  cachedWallet.consecutiveLosses += 1;

  activePaperPositions.delete(pos.tokenMint);
  closedPaperHistory.unshift(pos);
  await persistPaperTradingState();

  const lossUsd = costBasisUsd - netReturnUsd;
  const reasonLabel = isEmergencyRug ? 'EMERGENCY RUG CUT (-65%)' : 'CONFIRMED BREAKDOWN (-35%)';
  console.log(
    `🛡️ [PAPER HARD STOP-LOSS: ${reasonLabel}] $${pos.tokenSymbol} closed. Loss: -$${Math.abs(lossUsd).toFixed(2)}. Capital preserved: $${netReturnUsd.toFixed(2)}`
  );

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const cutCard = `
🛡️ <b>STOP-LOSS | $${pos.tokenSymbol}</b>
🩸 Loss: <b>-$${Math.abs(lossUsd).toFixed(2)} USD</b> (Preserved: +$${netReturnUsd.toFixed(2)})
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
      `.trim();
      bot.sendMessage(env.TELEGRAM_CHAT_ID, cutCard, { parse_mode: 'HTML' }).catch(() => {});
    } catch {}
  }

  // User Rule: "only when theres no profit at all then can it add money to the exsisting one to take our paper money back to $100"
  const remainingActive = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  ).length;
  if (remainingActive === 0 && cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD) {
    await checkAndRefillIfNoProfit('Last Active Position Concluded via Stop-Loss - Zero Profit Remaining');
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

  // --- Smart Shakeout Capital Protection Stop-Loss on un-profited tokens ---
  // - Emergency Rug Cut: If price collapses <= -65%, cut immediately with 0s delay
  // - Standard Stop-Loss: If price dips <= -35%, 45-second wick confirmation buffer
  if (pos.status === 'OPEN') {
    const isEmergencyRug = gainFromEntryPct <= -65.0;
    if (gainFromEntryPct <= -35.0) {
      if (!pos.firstUnderStopLossAt) {
        pos.firstUnderStopLossAt = Date.now();
        console.log(
          `⏳ [PAPER SHAKEOUT DEFENSE] $${pos.tokenSymbol} dipped ${gainFromEntryPct.toFixed(1)}%. Initiating 45s confirmation buffer...`
        );
      }

      const elapsedUnderSlMs = Date.now() - (pos.firstUnderStopLossAt || Date.now());
      const isConfirmed = isEmergencyRug || elapsedUnderSlMs >= 45_000;

      if (isConfirmed) {
        await executePaperStopLossExit(pos, currentPriceUsd, solPrice, pairData, gainFromEntryPct, isEmergencyRug);
        return;
      }
    } else if (pos.firstUnderStopLossAt) {
      console.log(`🛡️ [PAPER SHAKEOUT AVOIDED] $${pos.tokenSymbol} bounced back to ${gainFromEntryPct.toFixed(1)}%! Wiping stop-loss timer.`);
      pos.firstUnderStopLossAt = undefined;
    }
  }

  // =========================================================================
  // UNCAPPED TRAILING RUNNER SYSTEM (NO 3X/5X/10X CEILING CAP)
  // 1. Initial Scale-Out / De-risking: Returns 100% of invested principal.
  // 2. Uncapped Moonbag: Zero profit ceiling. As long as the market doesn't
  //    trail down, the runner keeps going up with the market (10X, 20X, 50X+).
  // 3. Trailing Stop: Sells remaining bag ONLY when price trails down from peak.
  // =========================================================================

  // =========================================================================
  // INFINITE TREND RIDER & CAPITAL MANAGEMENT ENGINE
  // "ride trends till forever so we can maximize profit. understand money management and capitals"
  // 1. Stage 1 (2.0X / +100%): 50% De-Risking -> Recovers 100% of the invested $1.00 capital!
  //    Trade is now 100% RISK-FREE. The $1.00 is returned to liquid cash to deploy into new gems.
  // 2. Stage 2 (5.0X / +400%): Harvests 25% of the remaining bag to bank massive profit to cash.
  // 3. Stage 3 (10.0X / +900%): Harvests 25% of the remaining bag to bank more profit to cash.
  // 4. Infinite Moonbag: The core runner bag rides the trend FOREVER.
  //    No artificial 3X/5X/10X caps. Coins can run to 20X, 50X, 100X, 500X+.
  // 5. Adaptive Trend Trailing Stop (35% drop from highest peak):
  //    Avoids premature stop-outs on normal crypto meme wicks while locking in peak gains
  //    only when the macro trend genuinely breaks down.
  // =========================================================================

  // Stage 1: Hit 2.0X (+100%) -> De-Risk 50% of tokens to secure 100% principal back
  if (!pos.tp1Hit && gainFromEntryPct >= 100.0) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

    const tokensToSell = pos.initialTokens * 0.5;
    const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
    const netReturnUsd = Math.max(0.01, grossReturnUsd - feeUsd);
    const costBasisUsd = pos.investedUsd * 0.5;

    pos.tp1Hit = true;
    pos.status = 'PARTIAL_TP_2X';
    pos.remainingTokens -= tokensToSell;
    pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
    pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.5;

    cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + netReturnUsd).toFixed(2));
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd = Number((cachedWallet.totalRealizedPnlUsd + (netReturnUsd - costBasisUsd)).toFixed(2));
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    await persistPaperTradingState();

    console.log(
      `🎯 [2X DE-RISK] $${pos.tokenSymbol} hit +${gainFromEntryPct.toFixed(0)}%! Sold 50% for +$${netReturnUsd.toFixed(2)}. 100% principal back in cash! Remaining bag riding trend forever!`
    );

    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
      try {
        const tpCard = `
🎯 <b>2X DE-RISKED | $${pos.tokenSymbol} (+${gainFromEntryPct.toFixed(0)}%)</b>
💵 Returned: <b>+$${netReturnUsd.toFixed(2)} USD</b> (Principal secured!)
💎 Runner: <b>Remaining bag riding trend forever</b>
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
        `.trim();
        await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
      } catch {}
    }
    return;
  }

  // Stage 2: Hit 5.0X (+400%) -> Harvest 25% of remaining tokens (lock in profit, keep 75% riding!)
  if (pos.tp1Hit && !pos.tp2Hit && gainFromEntryPct >= 400.0) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 40_000);

    const tokensToSell = pos.remainingTokens * 0.25;
    const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
    const netReturnUsd = Math.max(0.01, grossReturnUsd - feeUsd);
    const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 0.25;
    const costBasisUsd = pos.investedUsd * remainingFraction;

    pos.tp2Hit = true;
    pos.remainingTokens -= tokensToSell;
    pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
    pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * remainingFraction;

    cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + netReturnUsd).toFixed(2));
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd = Number((cachedWallet.totalRealizedPnlUsd + (netReturnUsd - costBasisUsd)).toFixed(2));
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    await persistPaperTradingState();

    console.log(
      `🚀 [5X HARVEST] $${pos.tokenSymbol} hit 5X (+${gainFromEntryPct.toFixed(0)}%)! Harvested 25% for +$${netReturnUsd.toFixed(2)}. Remaining 75% riding trend forever!`
    );

    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
      try {
        const tpCard = `
🚀 <b>5X HARVEST | $${pos.tokenSymbol} (+${gainFromEntryPct.toFixed(0)}%)</b>
💰 Harvested: <b>+$${netReturnUsd.toFixed(2)} USD</b> to cash
💎 Runner: <b>Core moonbag still riding trend!</b>
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
        `.trim();
        await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
      } catch {}
    }
    return;
  }

  // Stage 3: Hit 10.0X (+900%) -> Harvest another 25% of remaining tokens (lock in mega profit!)
  if (pos.tp1Hit && !pos.tp3Hit && gainFromEntryPct >= 900.0) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 50_000);

    const tokensToSell = pos.remainingTokens * 0.25;
    const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
    const netReturnUsd = Math.max(0.01, grossReturnUsd - feeUsd);
    const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 0.25;
    const costBasisUsd = pos.investedUsd * remainingFraction;

    pos.tp3Hit = true;
    pos.remainingTokens -= tokensToSell;
    pos.realizedPnlUsd += netReturnUsd - costBasisUsd;
    pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * remainingFraction;

    cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + netReturnUsd).toFixed(2));
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd = Number((cachedWallet.totalRealizedPnlUsd + (netReturnUsd - costBasisUsd)).toFixed(2));
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    await persistPaperTradingState();

    console.log(
      `🏆 [10X MEGA HARVEST] $${pos.tokenSymbol} hit 10X (+${gainFromEntryPct.toFixed(0)}%)! Harvested 25% for +$${netReturnUsd.toFixed(2)}. Remaining moonbag riding indefinitely!`
    );

    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
      try {
        const tpCard = `
🏆 <b>10X MEGA RUNNER | $${pos.tokenSymbol} (+${gainFromEntryPct.toFixed(0)}%)</b>
💰 Harvested: <b>+$${netReturnUsd.toFixed(2)} USD</b> to cash
💎 Runner: <b>Moonbag riding indefinitely!</b>
💼 Liquid Cash: <b>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</b>
        `.trim();
        await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, { parse_mode: 'HTML' });
      } catch {}
    }
    return;
  }

  // Stage 4: Dynamic Adaptive Trailing Stop for Moonbag Runners (35% pullback from highest peak)
  // Ensures the trend can breathe and ride indefinitely without premature stop-out on normal 15-20% wicks.
  const trailingStopPct = 35.0;
  if ((pos.tp1Hit || pos.peakMultiplier >= 2.0) && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
    await executePaperTrailingStopExit(pos, currentPriceUsd, solPrice, pairData, trailingStopPct, dropFromPeakPct, 'Infinite Trend Rider');
    return;
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
      autoRefillCount: cachedWallet.autoRefillCount || 0,
      totalRefilledUsd: cachedWallet.totalRefilledUsd || 0,
    },
    netWorthUsd,
    netWorthSol: Number((netWorthUsd / solPrice).toFixed(4)),
    unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
    totalPnlUsd,
    totalPnlPercent,
    autoRefillCount: cachedWallet.autoRefillCount || 0,
    totalRefilledUsd: cachedWallet.totalRefilledUsd || 0,
    activePositions: activeList,
    closedPositions: closedPaperHistory.slice(0, 20),
  };
}

/**
 * Test helper to simulate specific cash levels for automated verification
 */
export function setPaperWalletCashForTesting(cashUsd: number): void {
  cachedWallet.liquidCashUsd = cashUsd;
}

export interface ExitPaperPositionResult {
  success: boolean;
  tokenMint: string;
  tokenSymbol: string;
  tokensSold: number;
  grossReturnUsd: number;
  netReturnUsd: number;
  realizedPnlUsd: number;
  exitPriceUsd: number;
  newLiquidCashUsd: number;
  newLiquidCashSol: number;
  error?: string;
}

export interface ExitAllPaperPositionsResult {
  success: boolean;
  count: number;
  totalReturnedUsd: number;
  totalRealizedPnlUsd: number;
  newLiquidCashUsd: number;
  newLiquidCashSol: number;
  exitedPositions: ExitPaperPositionResult[];
  error?: string;
}

/**
 * Exits any individual paper trade and returns the proceeds directly back into the account liquid cash.
 */
export async function exitPaperPosition(
  tokenMintOrSymbol: string,
  reason: string = 'MANUAL'
): Promise<ExitPaperPositionResult> {
  const query = tokenMintOrSymbol.trim();
  // Find position by mint or ticker symbol
  let pos = activePaperPositions.get(query);
  if (!pos) {
    const cleanSym = query.replace(/^\$/, '').toUpperCase();
    for (const p of activePaperPositions.values()) {
      if (p.tokenSymbol.toUpperCase() === cleanSym && p.status !== 'CLOSED') {
        pos = p;
        break;
      }
    }
  }

  if (!pos || pos.status === 'CLOSED') {
    return {
      success: false,
      tokenMint: query,
      tokenSymbol: query,
      tokensSold: 0,
      grossReturnUsd: 0,
      netReturnUsd: 0,
      realizedPnlUsd: 0,
      exitPriceUsd: 0,
      newLiquidCashUsd: cachedWallet.liquidCashUsd,
      newLiquidCashSol: cachedWallet.liquidCashSol,
      error: `No active open position found for "${query}"`,
    };
  }

  const solPrice = await fetchLiveSolPrice();
  let currentPriceUsd = pos.currentPriceUsd;

  // Attempt live DexScreener price check
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`,
      { timeout: 3000 }
    );
    const pair = res.data?.pairs?.find((p: any) => p.chainId === 'solana');
    if (pair?.priceUsd) {
      const p = parseFloat(pair.priceUsd);
      if (p > 0) currentPriceUsd = p;
    }
  } catch {}

  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
  const sellSlippage = calculateRealSlippage(30_000);

  const tokensToSell = pos.remainingTokens;
  const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
  const netReturnUsd = Number(Math.max(0.01, grossReturnUsd - feeUsd).toFixed(2));
  const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 1.0;
  const costBasisUsd = pos.investedUsd * remainingFraction;

  pos.status = 'CLOSED';
  pos.closedAt = Date.now();
  pos.remainingTokens = 0;
  pos.exitReason = (reason as any) || 'MANUAL';
  pos.sellGasFeeSol = feeSol;
  pos.sellGasFeeUsd = feeUsd;
  pos.sellSlippagePct = Number((sellSlippage * 100).toFixed(2));
  const realizedPnlUsd = Number((netReturnUsd - costBasisUsd).toFixed(2));
  pos.realizedPnlUsd += realizedPnlUsd;
  pos.realizedSolProfit += (netReturnUsd / solPrice) - (pos.investedSol * remainingFraction);

  // Return money directly back to the account!
  cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + netReturnUsd).toFixed(2));
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.totalRealizedPnlUsd = Number((cachedWallet.totalRealizedPnlUsd + realizedPnlUsd).toFixed(2));
  cachedWallet.totalFeesPaidSol += feeSol;
  cachedWallet.totalFeesPaidUsd += feeUsd;

  if (realizedPnlUsd >= 0) {
    cachedWallet.winningTrades += 1;
    cachedWallet.consecutiveLosses = 0;
  } else {
    cachedWallet.losingTrades += 1;
    cachedWallet.consecutiveLosses += 1;
  }

  activePaperPositions.delete(pos.tokenMint);
  closedPaperHistory.unshift(pos);
  await persistPaperTradingState();

  // If zero active positions left and liquid cash <= $20, check conditional refill
  const remainingActive = Array.from(activePaperPositions.values()).filter(p => p.status !== 'CLOSED').length;
  if (remainingActive === 0 && cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD) {
    await checkAndRefillIfNoProfit(`Manual exit of $${pos.tokenSymbol} - zero active positions remaining`);
  }

  console.log(
    `🚨 [MANUAL TRADE EXIT] $${pos.tokenSymbol} exited. Returned +$${netReturnUsd.toFixed(2)} USD back to account cash. Realized PnL: ${realizedPnlUsd >= 0 ? '+' : ''}$${realizedPnlUsd.toFixed(2)}. New Liquid Cash: $${cachedWallet.liquidCashUsd.toFixed(2)} USD`
  );

  return {
    success: true,
    tokenMint: pos.tokenMint,
    tokenSymbol: pos.tokenSymbol,
    tokensSold: tokensToSell,
    grossReturnUsd: Number(grossReturnUsd.toFixed(2)),
    netReturnUsd,
    realizedPnlUsd,
    exitPriceUsd: currentPriceUsd,
    newLiquidCashUsd: cachedWallet.liquidCashUsd,
    newLiquidCashSol: cachedWallet.liquidCashSol,
  };
}

/**
 * Exits ALL active open paper trades simultaneously and credits 100% of proceeds back to the account.
 */
export async function exitAllPaperPositions(reason: string = 'MANUAL_EXIT_ALL'): Promise<ExitAllPaperPositionsResult> {
  const activeList = Array.from(activePaperPositions.values()).filter(p => p.status !== 'CLOSED');
  if (activeList.length === 0) {
    return {
      success: true,
      count: 0,
      totalReturnedUsd: 0,
      totalRealizedPnlUsd: 0,
      newLiquidCashUsd: cachedWallet.liquidCashUsd,
      newLiquidCashSol: cachedWallet.liquidCashSol,
      exitedPositions: [],
    };
  }

  const solPrice = await fetchLiveSolPrice();
  const exitedPositions: ExitPaperPositionResult[] = [];
  let totalReturnedUsd = 0;
  let totalRealizedPnlUsd = 0;

  for (const pos of activeList) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(30_000);

    const tokensToSell = pos.remainingTokens;
    const grossReturnUsd = tokensToSell * pos.currentPriceUsd * (1 - sellSlippage);
    const netReturnUsd = Number(Math.max(0.01, grossReturnUsd - feeUsd).toFixed(2));
    const remainingFraction = pos.initialTokens > 0 ? tokensToSell / pos.initialTokens : 1.0;
    const costBasisUsd = pos.investedUsd * remainingFraction;

    pos.status = 'CLOSED';
    pos.closedAt = Date.now();
    pos.remainingTokens = 0;
    pos.exitReason = (reason as any) || 'MANUAL';
    pos.sellGasFeeSol = feeSol;
    pos.sellGasFeeUsd = feeUsd;
    pos.sellSlippagePct = Number((sellSlippage * 100).toFixed(2));
    const pnl = Number((netReturnUsd - costBasisUsd).toFixed(2));
    pos.realizedPnlUsd += pnl;
    pos.realizedSolProfit += (netReturnUsd / solPrice) - (pos.investedSol * remainingFraction);

    // Return proceeds directly to account cash!
    cachedWallet.liquidCashUsd = Number((cachedWallet.liquidCashUsd + netReturnUsd).toFixed(2));
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd = Number((cachedWallet.totalRealizedPnlUsd + pnl).toFixed(2));
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    if (pnl >= 0) {
      cachedWallet.winningTrades += 1;
      cachedWallet.consecutiveLosses = 0;
    } else {
      cachedWallet.losingTrades += 1;
      cachedWallet.consecutiveLosses += 1;
    }

    activePaperPositions.delete(pos.tokenMint);
    closedPaperHistory.unshift(pos);

    totalReturnedUsd += netReturnUsd;
    totalRealizedPnlUsd += pnl;

    exitedPositions.push({
      success: true,
      tokenMint: pos.tokenMint,
      tokenSymbol: pos.tokenSymbol,
      tokensSold: tokensToSell,
      grossReturnUsd: Number(grossReturnUsd.toFixed(2)),
      netReturnUsd,
      realizedPnlUsd: pnl,
      exitPriceUsd: pos.currentPriceUsd,
      newLiquidCashUsd: cachedWallet.liquidCashUsd,
      newLiquidCashSol: cachedWallet.liquidCashSol,
    });
  }

  await persistPaperTradingState();

  // Check if zero active positions left and cash <= $20 floor
  if (cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD) {
    await checkAndRefillIfNoProfit(`Manual exit all completed - zero active positions remaining`);
  }

  console.log(
    `🚨 [MANUAL EXIT ALL] Liquidated ${exitedPositions.length} active trade(s). Returned +$${totalReturnedUsd.toFixed(2)} USD back to account cash. New Liquid Cash: $${cachedWallet.liquidCashUsd.toFixed(2)} USD`
  );

  return {
    success: true,
    count: exitedPositions.length,
    totalReturnedUsd: Number(totalReturnedUsd.toFixed(2)),
    totalRealizedPnlUsd: Number(totalRealizedPnlUsd.toFixed(2)),
    newLiquidCashUsd: cachedWallet.liquidCashUsd,
    newLiquidCashSol: cachedWallet.liquidCashSol,
    exitedPositions,
  };
}
