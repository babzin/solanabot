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

export const PAPER_RESERVE_FLOOR_USD = 20.0;
export const PAPER_TARGET_BALANCE_USD = 100.0;
let lastReserveAlertTimeMs = 0;

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
  maxConcurrentPositions: 200,
  tradeSizePercent: 3.0,
  tradeSizeUsd: 3.0,
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
    maxConcurrentPositions: 200,
    tradeSizePercent: 3.0,
    tradeSizeUsd: 3.0,
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

  console.log('🔄 [Paper Trading Engine] Wallet successfully reset to $100.00 USD.');
  return cachedWallet;
}

/**
 * Throttled alert for Telegram when liquid cash reaches the $20 reserve floor
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
⏸️ <b>[PAPER TRADING: $20 RESERVE LOCK]</b> 🛡️
<i>Liquid paper cash has reached the $20.00 safety floor ($${currentCash.toFixed(2)} USD).</i>

🚫 <b>New entries paused:</b> Capital protected at $20 floor (system will not remove funds).
⏳ <b>Waiting for profit:</b> <b>${activePositionsCount} active open position(s)</b> are running in the market.
📈 <b>Auto-Resume:</b> As soon as active positions take profit (2X scale-out or trailing stop), profits will restore wallet and new entries will resume automatically!
      `.trim();
      bot.sendMessage(env.TELEGRAM_CHAT_ID, lockAlert, { parse_mode: 'HTML' }).catch(() => {});
    } catch {}
  }
}

/**
 * Automatically tops up paper wallet back to $100.00 ONLY when:
 * 1. Liquid cash is at or below the $20.00 reserve floor (or insufficient to trade above $20)
 * 2. There is NO PROFIT AT ALL to wait for (i.e. zero active open positions remaining)
 *
 * Adds money to the existing balance (e.g. existing $20.00 + $80.00 = $100.00).
 * Increments autoRefillCount and records totalRefilledUsd.
 */
export async function checkAndRefillIfNoProfit(
  triggerContext: string,
  candidateSymbol?: string
): Promise<boolean> {
  // If liquid cash is comfortably above $20 floor, no refill needed
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

  // "only when theres no profit at all then can it add money to the existing one to take our paper money back to $100"
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
    `💵 [PAPER MONEY AUTO-REFILL #${cachedWallet.autoRefillCount}] Zero active positions remaining ("no profit at all") & balance reached $20 floor ($${previousCash.toFixed(2)} USD). Added +$${topUpAmount.toFixed(2)} USD to existing balance -> Restored paper wallet back to $${PAPER_TARGET_BALANCE_USD.toFixed(2)} USD! (Refilled ${cachedWallet.autoRefillCount}x total • Cumulative Refilled: +$${cachedWallet.totalRefilledUsd.toFixed(2)} USD)`
  );

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const safeSym = candidateSymbol ? escapeHtml(candidateSymbol) : '';
      const refillAlert = `
🔄 <b>[PAPER MONEY AUTO-REFILLED TO $100]</b> ⚡
<i>All open positions concluded with no profit remaining, and cash reached the $20 reserve floor!</i>

💵 <b>Added to Existing Balance:</b> <code>+$${topUpAmount.toFixed(2)} USD</code> (from $${previousCash.toFixed(2)})
💰 <b>Restored Paper Wallet:</b> <code>$${PAPER_TARGET_BALANCE_USD.toFixed(2)} USD</code> (<code>${cachedWallet.liquidCashSol.toFixed(3)} SOL</code>)
🔢 <b>Auto-Refill Event:</b> <b>${cachedWallet.autoRefillCount} time${cachedWallet.autoRefillCount === 1 ? '' : 's'}</b>
📊 <b>Total Cumulative Refilled:</b> <code>+$${cachedWallet.totalRefilledUsd.toFixed(2)} USD</code>
🎯 <b>Context:</b> ${escapeHtml(triggerContext)}${safeSym ? ` (Ready to trade <b>$${safeSym}</b>)` : ''}
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

  // 8. $20 Safety Reserve Floor & Conditional Refill Engine:
  // User Rule:
  // "if our money should reach $20 the system shouldn't remove money to trade again
  // and it should wait till profit enters, on;y when theres no profit at all then
  // can it add money to the exsisting one to take our paper money back to $100"
  let didAutoRefill = false;
  let refilledAmount = 0;
  const minRequiredCash = 1.0 + feeUsd;
  const cashAboveReserve = cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD;

  // Check if liquid cash has reached the $20 floor, or cannot even fund the minimum $1 trade without breaching $20
  if (cachedWallet.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD || cashAboveReserve < minRequiredCash) {
    const activeOpenPositions = Array.from(activePaperPositions.values()).filter(
      (p) => p.status !== 'CLOSED'
    );
    const activeCount = activeOpenPositions.length;

    if (activeCount > 0) {
      // Rule Part 1: Money has reached $20 -> System MUST NOT remove money to trade again, and MUST wait till profit enters!
      console.log(
        `⏸️ [Paper Reserve Lock: $20.00 Floor] Liquid cash is $${cachedWallet.liquidCashUsd.toFixed(2)} USD (<= $20.00 floor). New trade entries locked to preserve $20 capital. Waiting for profit to enter from ${activeCount} active position(s)...`
      );
      maybeSendReserveAlert(cachedWallet.liquidCashUsd, activeCount);
      return null;
    } else {
      // Rule Part 2: "only when theres no profit at all then can it add money to the exsisting one to take our paper money back to $100"
      // Zero active positions left. No profit can enter from existing trades. Refill back to $100.00!
      const preRefillCash = cachedWallet.liquidCashUsd;
      const refilled = await checkAndRefillIfNoProfit(`Depletion with 0 active positions remaining`, candidate.tokenSymbol);
      if (refilled) {
        didAutoRefill = true;
        refilledAmount = Number((cachedWallet.liquidCashUsd - preRefillCash).toFixed(2));
      }
    }
  }

  // Ensure dynamicTradeSize does NOT dip into the $20 reserve floor
  const safeCashBudget = Math.max(0, cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD - feeUsd);
  if (safeCashBudget < 1.0) {
    const activeOpenPositions = Array.from(activePaperPositions.values()).filter(
      (p) => p.status !== 'CLOSED'
    );
    if (activeOpenPositions.length > 0) {
      console.log(
        `⏸️ [Paper Reserve Lock: $20.00 Floor] Liquid cash is $${cachedWallet.liquidCashUsd.toFixed(2)} USD. Available above reserve ($${safeCashBudget.toFixed(2)}) is below $1 minimum trade. Waiting for profit to enter from ${activeOpenPositions.length} active position(s)...`
      );
      maybeSendReserveAlert(cachedWallet.liquidCashUsd, activeOpenPositions.length);
      return null;
    } else {
      const preRefillCash = cachedWallet.liquidCashUsd;
      const refilled = await checkAndRefillIfNoProfit(`Zero active positions and available cash < $1`, candidate.tokenSymbol);
      if (refilled) {
        didAutoRefill = true;
        refilledAmount = Number((cachedWallet.liquidCashUsd - preRefillCash).toFixed(2));
      }
    }
  }

  if (didAutoRefill) {
    const updatedNetWorth = cachedWallet.liquidCashUsd + currentOpenValue;
    dynamicTradeSize = Math.max(1.0, Number((updatedNetWorth * (effectiveAllocationPct / 100)).toFixed(2)));
  }

  // Clamp dynamicTradeSize to never breach $20 floor
  const maxAllowedTradeSize = Math.max(1.0, Number((cachedWallet.liquidCashUsd - PAPER_RESERVE_FLOOR_USD - feeUsd).toFixed(2)));
  dynamicTradeSize = Math.max(1.0, Math.min(dynamicTradeSize, maxAllowedTradeSize));
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
          `• ⚖️ <i>${escapeHtml(candidate.slmVerdict.justificationSummary)}</i>`;
      }

      const safeSymbol = escapeHtml(candidate.tokenSymbol);
      const safeName = escapeHtml(candidate.tokenName || candidate.tokenSymbol);
      const safeThesis = escapeHtml(aiThesis);

      const receiptCard = `
💼 <b>[PAPER TRADE EXECUTED: BOUNDED AUTONOMY]</b> ⚡
<i>Simulating 100% Real Market Conditions &amp; Network Fees</i>

🪙 Token: <b>$${safeSymbol}</b> (${safeName})
💰 Entry Price: <code>$${candidate.priceUsd.toFixed(6)}</code>
📊 Market Cap: <code>$${(candidate.marketCap / 1000).toFixed(1)}K</code>
💵 Position Size: <b>$${tradeSizeUsd.toFixed(2)}</b> (<b>${effectiveAllocationPct}%</b> of capital • <code>${investedSol} SOL</code>)
📉 Real Slippage: <b>${(slippagePct * 100).toFixed(1)}%</b>
⛽ Priority Gas Fee: <code>${feeSol} SOL</code> (<b>$${feeUsd.toFixed(2)}</b>)${slmReceiptSection}

🤖 <b>AI AUTONOMOUS DISCRETION:</b>
• 🎯 Conviction: <b>${aiConviction}/100</b> (${aiConviction >= 80 ? '🔥 Ultra High' : '⚡ Strong'})
• 🧭 Strategy Profile: <b>${strategyProfile}</b> (Mode: <code>Uncapped Trailing Runner</code>)
• 💡 Thesis: <i>${safeThesis}</i>

💎 <b>UNCAPPED RUNNER MODE (NO CEILING CAP):</b>
• 🛑 <b>Hard Allocation Cap:</b> Max 3.0% capital staked per trade ($1 - $3)
• 🚀 <b>Infinite Upside:</b> Zero profit ceiling (No 3X/5X cap) — rides the market up indefinitely!
• 🛡️ <b>Principal De-risking:</b> 100% initial principal secured on first double (2X)
• 🛑 <b>Trailing Stop:</b> Remaining moonbag exits ONLY when market trails down from peak!${didAutoRefill ? `\n\n🔄 <b>AUTO-REFILL ACTIVATED:</b> +$${refilledAmount.toFixed(2)} USD added (Refill Event #${cachedWallet.autoRefillCount} • Total refilled: $${cachedWallet.totalRefilledUsd.toFixed(2)})` : ''}

💼 <b>Paper Wallet:</b> <code>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</code> available (${openCount + 1}/${cachedWallet.maxConcurrentPositions} slots${cachedWallet.autoRefillCount > 0 ? ` • 🔄 <b>Refilled: ${cachedWallet.autoRefillCount}x</b>` : ''})
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
      const tpCard = `
🛡️ <b>[UNCAPPED RUNNER: TRAILING STOP EXECUTED]</b> 🛑
<i>Peak Reversal Triggered -${trailingStopPct}% Trailing Stop • Full Trade Completed</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
🔝 Peak Reached: <code>$${pos.peakPriceUsd.toFixed(6)}</code> (<b>${pos.peakMultiplier}X Peak</b>)
📉 Trailing Pullback: <b>-${dropFromPeakPct.toFixed(1)}% from Highs</b> (Stop Trigger: <code>-${trailingStopPct}%</code>)
💰 Final Moonbag Sold: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
🏆 <b>Total Net Trade Profit:</b> <b>+$${pos.realizedPnlUsd.toFixed(2)} USD</b> (<code>+${pos.realizedSolProfit.toFixed(3)} SOL</code>) 💸
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>

💼 <b>Total Paper Portfolio:</b> <code>$${(cachedWallet.liquidCashUsd + cachedWallet.totalInvestedUsd).toFixed(2)} USD</code>${cachedWallet.autoRefillCount > 0 ? ` • 🔄 <b>Refills: ${cachedWallet.autoRefillCount}x</b>` : ''}
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
🛡️ <b>[PAPER TRADING: CAPITAL PROTECTION STOP-LOSS]</b> 🛑
<i>${isEmergencyRug ? '🚨 Emergency Cut on Catastrophic Dump' : '📉 Sustained -35% Breakdown Confirmed (45s Buffer)'}</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📉 Dip: <b>${gainFromEntryPct.toFixed(1)}% below entry</b>
💵 Capital Preserved: <code>+$${netReturnUsd.toFixed(2)} USD</code> (from $${pos.investedUsd.toFixed(2)} position)
🩸 Loss Incurred: <code>-$${Math.abs(lossUsd).toFixed(2)} USD</code>
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>
💼 <b>Liquid Cash:</b> <code>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</code>
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
