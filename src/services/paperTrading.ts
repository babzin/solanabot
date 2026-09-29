import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { redis } from './redis.js';
import { bot } from './telegram.js';

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
  exitReason?: 'HARD_STOP_35' | 'HARD_STOP_25' | 'TRAILING_STOP' | 'MANUAL' | 'EMERGENCY_RUG_CUT';
  firstUnderStopLossAt?: number;
  sellGasFeeSol?: number;
  sellGasFeeUsd?: number;
  sellSlippagePct?: number;
  openedAt: number;
  closedAt?: number;
  dexUrl: string;
  imageUrl?: string | null;
  peakMultiplier: number;
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
      invested += pos.status === 'PARTIAL_TP_2X' ? pos.investedUsd * 0.5 : pos.investedUsd;
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
  console.log('💵 [Paper Trading Engine] Initializing $100 real-market simulator...');
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
export async function processPaperTradeBuy(candidate: {
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  priceUsd: number;
  marketCap: number;
  liquidityUsd?: number;
  dexUrl?: string;
  imageUrl?: string | null;
}): Promise<PaperPosition | null> {
  const solPrice = await fetchLiveSolPrice();

  // 1. Check if already actively holding this token
  const existingPos = activePaperPositions.get(candidate.tokenMint);
  if (existingPos && existingPos.status !== 'CLOSED') {
    return null;
  }

  // 1b. Smart Re-Trade Rule:
  // If a coin was previously traded and closed at a loss:
  // Block re-entry if it is still low / dumping.
  // Allow re-entry ONLY if it has proven profitable OR has recovered and broken out above previous entry price!
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

  // 2. Count active open positions
  const openCount = Array.from(activePaperPositions.values()).filter(
    (p) => p.status !== 'CLOSED'
  ).length;
  if (openCount >= cachedWallet.maxConcurrentPositions) {
    console.log(
      `💼 [Paper Trading] Max concurrent positions (${cachedWallet.maxConcurrentPositions}) reached. Skipping $${candidate.tokenSymbol}.`
    );
    return null;
  }

  // 3. Compute dynamic 3% allocation of current total capital (compounding)
  let currentOpenValue = 0;
  for (const pos of activePaperPositions.values()) {
    if (pos.status !== 'CLOSED') {
      currentOpenValue += pos.remainingTokens * pos.currentPriceUsd;
    }
  }
  const currentNetWorth = cachedWallet.liquidCashUsd + currentOpenValue;
  const pct = cachedWallet.tradeSizePercent || 3.0; // 3% of capital
  const dynamicTradeSize = Math.max(1.0, Number((currentNetWorth * (pct / 100)).toFixed(2)));
  const tradeSizeUsd = dynamicTradeSize;
  cachedWallet.tradeSizeUsd = dynamicTradeSize;

  // 4. Compute real network friction
  const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
  const totalRequiredCash = tradeSizeUsd + feeUsd;

  // 5. Verify liquid cash availability
  if (cachedWallet.liquidCashUsd < totalRequiredCash) {
    console.log(
      `💼 [Paper Trading] Insufficient liquid cash ($${cachedWallet.liquidCashUsd.toFixed(2)} < $${totalRequiredCash.toFixed(2)}). Skipping $${candidate.tokenSymbol}.`
    );
    return null;
  }

  // 6. Compute real slippage & price impact
  const slippagePct = calculateRealSlippage(candidate.liquidityUsd || 25_000);
  const effectiveTokens =
    (tradeSizeUsd / Math.max(0.00000001, candidate.priceUsd)) * (1 - slippagePct);
  const investedSol = Number((tradeSizeUsd / solPrice).toFixed(4));

  // 7. Deduct from liquid cash
  cachedWallet.liquidCashUsd -= totalRequiredCash;
  cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
  cachedWallet.totalFeesPaidSol += feeSol;
  cachedWallet.totalFeesPaidUsd += feeUsd;
  cachedWallet.totalTrades += 1;

  // 8. Create Position
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
  };

  activePaperPositions.set(candidate.tokenMint, position);
  await persistPaperTradingState();

  console.log(
    `🎯 [PAPER TRADE OPENED: 3% ALLOCATION] $${candidate.tokenSymbol} at $${candidate.priceUsd.toFixed(6)} | Size: $${tradeSizeUsd.toFixed(2)} (3% of $${currentNetWorth.toFixed(2)}) | Slipped: ${(slippagePct * 100).toFixed(1)}% | Gas: ${feeSol} SOL ($${feeUsd.toFixed(2)}) | Remaining Cash: $${cachedWallet.liquidCashUsd.toFixed(2)}`
  );

  // Send Telegram receipt
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      const receiptCard = `
💼 <b>[PAPER TRADE EXECUTED: 3% ALLOCATION]</b> ⚡
<i>Simulating 100% Real Market Conditions &amp; Network Fees</i>

🪙 Token: <b>$${candidate.tokenSymbol}</b> (${candidate.tokenName})
💰 Entry Price: <code>$${candidate.priceUsd.toFixed(6)}</code>
📊 Market Cap: <code>$${(candidate.marketCap / 1000).toFixed(1)}K</code>
💵 Position Size: <b>$${tradeSizeUsd.toFixed(2)}</b> (3% of capital • <code>${investedSol} SOL</code>)
📉 Real Slippage: <b>${(slippagePct * 100).toFixed(1)}%</b>
⛽ Priority Gas Fee: <code>${feeSol} SOL</code> (<b>$${feeUsd.toFixed(2)}</b>)

🛡️ <b>AUTOMATED EXIT RULES ACTIVE:</b>
• 🎯 <b>2X Take-Profit:</b> Sell 50% at <code>$${(candidate.priceUsd * 2).toFixed(6)}</code> to secure original $${tradeSizeUsd.toFixed(2)}!
• 🌙 <b>Moonbag Trailing SL:</b> -40% from peak on remaining 50% (Wide Runner Buffer)
• 🛡️ <b>Capital Stop-Loss:</b> -35% cut with 45s shakeout buffer (Emergency cut at -65%)

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

  // RULE 1: +100% (2X Take-Profit) - Sells 50% to secure 100% of initial $10 principal!
  if (pos.status === 'OPEN' && gainFromEntryPct >= 100.0) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 30_000);

    const tokensToSell = pos.initialTokens * 0.5;
    const grossReturnUsd = tokensToSell * currentPriceUsd * (1 - sellSlippage);
    const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);

    pos.status = 'PARTIAL_TP_2X';
    pos.remainingTokens = pos.initialTokens * 0.5;
    pos.realizedPnlUsd += netReturnUsd - pos.investedUsd * 0.5;
    pos.realizedSolProfit += netReturnUsd / solPrice - pos.investedSol * 0.5;

    // Credit proceeds back to liquid cash
    cachedWallet.liquidCashUsd += netReturnUsd;
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd += netReturnUsd - pos.investedUsd * 0.5;
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    await persistPaperTradingState();

    console.log(
      `🎯 [PAPER 2X TAKE-PROFIT] $${pos.tokenSymbol} hit +${gainFromEntryPct.toFixed(1)}%! Sold 50% for +$${netReturnUsd.toFixed(2)}. Principal secured!`
    );

    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
      try {
        const tpCard = `
🎯 <b>[PAPER TRADING: 2X TAKE-PROFIT HIT]</b> 🚀
<i>Automated 50% Scale-Out Executed</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
📈 Gain: <b>+${gainFromEntryPct.toFixed(1)}% (2.0X Multiplier)</b>
💰 Action: <b>Sold 50% of position</b>
💵 Net Harvested: <code>+$${netReturnUsd.toFixed(2)} USD</code> (<code>+${(netReturnUsd / solPrice).toFixed(3)} SOL</code>)
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>
🌙 <b>Moonbag:</b> Remaining 50% riding risk-free with <b>Trailing Stop-Loss (-25% from peak)</b>!

💼 <b>Updated Liquid Cash:</b> <code>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</code>
        `.trim();

        await bot.sendMessage(env.TELEGRAM_CHAT_ID, tpCard, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: '📊 DexScreener Chart', url: pos.dexUrl }]],
          },
        });
      } catch {}
    }
    return;
  }

  // RULE 2: Trailing Stop-Loss on remaining Moonbag: -40% from peak
  // Sized with wide breathing room to allow 5X-20X runners to consolidate without early exit
  if (pos.status === 'PARTIAL_TP_2X' && dropFromPeakPct >= 40.0) {
    const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
    const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 20_000);

    const grossMoonbagUsd = pos.remainingTokens * currentPriceUsd * (1 - sellSlippage);
    const netMoonbagUsd = Math.max(0, grossMoonbagUsd - feeUsd);

    pos.status = 'CLOSED';
    pos.closedAt = Date.now();
    pos.remainingTokens = 0;
    pos.exitReason = 'TRAILING_STOP';
    pos.sellGasFeeSol = feeSol;
    pos.sellGasFeeUsd = feeUsd;
    pos.sellSlippagePct = Number((sellSlippage * 100).toFixed(2));
    pos.realizedPnlUsd += netMoonbagUsd - pos.investedUsd * 0.5;
    pos.realizedSolProfit += netMoonbagUsd / solPrice - pos.investedSol * 0.5;

    // Credit proceeds back to liquid cash
    cachedWallet.liquidCashUsd += netMoonbagUsd;
    cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
    cachedWallet.totalRealizedPnlUsd += netMoonbagUsd - pos.investedUsd * 0.5;
    cachedWallet.totalFeesPaidSol += feeSol;
    cachedWallet.totalFeesPaidUsd += feeUsd;

    if (pos.realizedPnlUsd > 0) {
      cachedWallet.winningTrades += 1;
    } else {
      cachedWallet.losingTrades += 1;
    }

    activePaperPositions.delete(pos.tokenMint);
    closedPaperHistory.unshift(pos);
    await persistPaperTradingState();

    console.log(
      `🛑 [PAPER TRAILING STOP] $${pos.tokenSymbol} retraced -${dropFromPeakPct.toFixed(1)}% from peak. Moonbag cashed out for +$${netMoonbagUsd.toFixed(2)}. Total Trade PnL: +$${pos.realizedPnlUsd.toFixed(2)}`
    );

    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
      try {
        const pnlSign = pos.realizedPnlUsd >= 0 ? '+' : '';
        const pnlEmoji = pos.realizedPnlUsd >= 0 ? '💸' : '🩸';
        const trailCard = `
🛑 <b>[PAPER TRADING: TRAILING STOP EXECUTED]</b> 📉
<i>Peak Reversal Protection Activated (-40% from Peak)</i>

🪙 Token: <b>$${pos.tokenSymbol}</b>
🔝 Peak Price: <code>$${pos.peakPriceUsd.toFixed(6)}</code> (${pos.peakMultiplier}X)
📉 Exit Price: <code>$${currentPriceUsd.toFixed(6)}</code> (-${dropFromPeakPct.toFixed(1)}% from ATH)
💰 Moonbag Liquidated: <code>+$${netMoonbagUsd.toFixed(2)} USD</code>
🏆 <b>Total Net Trade Profit:</b> <b>${pnlSign}$${pos.realizedPnlUsd.toFixed(2)} USD</b> ${pnlEmoji}
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>

💼 <b>Total Paper Portfolio:</b> <code>$${(cachedWallet.liquidCashUsd + cachedWallet.totalInvestedUsd).toFixed(2)} USD</code>
        `.trim();

        await bot.sendMessage(env.TELEGRAM_CHAT_ID, trailCard, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: '📊 DexScreener Chart', url: pos.dexUrl }]],
          },
        });
      } catch {}
    }
    return;
  }

  // RULE 3: Smart Shakeout Capital Stop-Loss on un-profited tokens
  // - Emergency Rug Cut: If price collapses <= -65%, cut immediately with 0s delay
  // - Standard Stop-Loss: If price dips <= -35%, initiate a 45-second wick confirmation buffer
  //   If price bounces back above -35% before 45s, the timer resets and the shakeout is avoided!
  if (pos.status === 'OPEN') {
    const isEmergencyRug = gainFromEntryPct <= -65.0;

    if (gainFromEntryPct <= -35.0) {
      if (!pos.firstUnderStopLossAt) {
        pos.firstUnderStopLossAt = Date.now();
        console.log(
          `⏳ [PAPER SHAKEOUT DEFENSE] $${pos.tokenSymbol} dipped ${gainFromEntryPct.toFixed(1)}%. Initiating 45s confirmation buffer to filter out micro-wicks...`
        );
      }

      const elapsedUnderSlMs = Date.now() - (pos.firstUnderStopLossAt || Date.now());
      const isConfirmed = isEmergencyRug || elapsedUnderSlMs >= 45_000;

      if (!isConfirmed) {
        console.log(
          `⏳ [PAPER SHAKEOUT DEFENSE] $${pos.tokenSymbol} under -35% for ${Math.floor(elapsedUnderSlMs / 1000)}s/45s. Holding position through temporary dip...`
        );
        return;
      }

      // Sustained breakdown confirmed or emergency rug cut triggered!
      const { feeSol, feeUsd } = calculateRealNetworkGas(solPrice);
      const sellSlippage = calculateRealSlippage(pairData?.liquidity?.usd || 15_000);

      const grossReturnUsd = pos.remainingTokens * currentPriceUsd * (1 - sellSlippage);
      const netReturnUsd = Math.max(0, grossReturnUsd - feeUsd);
      const lossUsd = netReturnUsd - pos.investedUsd;

      pos.status = 'CLOSED';
      pos.closedAt = Date.now();
      pos.remainingTokens = 0;
      pos.exitReason = isEmergencyRug ? 'EMERGENCY_RUG_CUT' : 'HARD_STOP_35';
      pos.sellGasFeeSol = feeSol;
      pos.sellGasFeeUsd = feeUsd;
      pos.sellSlippagePct = Number((sellSlippage * 100).toFixed(2));
      pos.realizedPnlUsd = lossUsd;
      pos.realizedSolProfit = lossUsd / solPrice;

      // Return remaining cash back to wallet
      cachedWallet.liquidCashUsd += netReturnUsd;
      cachedWallet.liquidCashSol = Number((cachedWallet.liquidCashUsd / solPrice).toFixed(4));
      cachedWallet.totalRealizedPnlUsd += lossUsd;
      cachedWallet.totalFeesPaidSol += feeSol;
      cachedWallet.totalFeesPaidUsd += feeUsd;
      cachedWallet.losingTrades += 1;

      activePaperPositions.delete(pos.tokenMint);
      closedPaperHistory.unshift(pos);
      await persistPaperTradingState();

      const reasonLabel = isEmergencyRug ? 'EMERGENCY RUG DUMP (-65%+)' : 'SUSTAINED -35% BREAKDOWN';
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
🩸 Loss Incurred: <code>-$${Math.abs(lossUsd).toFixed(2)} USD</code> (including real gas &amp; slippage)
⛽ Sell Gas: <code>${feeSol} SOL</code> | Slippage: <code>${(sellSlippage * 100).toFixed(1)}%</code>

💼 <b>Liquid Cash Preserved:</b> <code>$${cachedWallet.liquidCashUsd.toFixed(2)} USD</code>
          `.trim();

          await bot.sendMessage(env.TELEGRAM_CHAT_ID, cutCard, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: '📊 DexScreener Chart', url: pos.dexUrl }]],
            },
          });
        } catch {}
      }
      return;
    } else if (pos.firstUnderStopLossAt) {
      // Price recovered above -35%! Shakeout successfully avoided!
      console.log(
        `🛡️ [PAPER SHAKEOUT AVOIDED] $${pos.tokenSymbol} bounced back to ${gainFromEntryPct.toFixed(1)}%! Wiping stop-loss timer. Token allowed to pump!`
      );
      pos.firstUnderStopLossAt = undefined;
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
      const initialCostOfRemaining =
        pos.status === 'PARTIAL_TP_2X' ? pos.investedUsd * 0.5 : pos.investedUsd;
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
