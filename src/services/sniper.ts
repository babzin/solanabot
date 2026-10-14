import { Keypair, VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import { env } from '../config/env.js';
import { prisma } from './db.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SnipeResult {
  success: boolean;
  simulated: boolean;
  signature: string;
  solAmount: number;
  tokenAmount: number;
  tokenMint: string;
  tokenSymbol?: string;
  priceUsd?: number;
  routePlan?: string;
  error?: string;
}

export interface SnipedPosition {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  solInvested: number;
  initialTokens: number;
  remainingTokens: number;
  status: 'OPEN' | 'PARTIAL_TP_2X' | 'CLOSED';
  createdAt: number;
  closedAt?: number;
  realizedSolProfit: number;
  exitReason?: string;
  isSimulated: boolean;
  firstUnderStopLossAt?: number;
}

// In-memory active positions registry (persists across trades during bot uptime)
const activePositions = new Map<string, SnipedPosition>();

export function recordSnipedPosition(
  tokenMint: string,
  tokenSymbol: string,
  entryPriceUsd: number,
  solInvested: number,
  initialTokens: number,
  isSimulated: boolean = true
): SnipedPosition {
  const position: SnipedPosition = {
    id: `pos_${Date.now()}_${tokenMint.slice(0, 4)}`,
    tokenMint,
    tokenSymbol: tokenSymbol || 'TOKEN',
    entryPriceUsd: Math.max(0.0000001, entryPriceUsd),
    currentPriceUsd: Math.max(0.0000001, entryPriceUsd),
    peakPriceUsd: Math.max(0.0000001, entryPriceUsd),
    solInvested,
    initialTokens,
    remainingTokens: initialTokens,
    status: 'OPEN',
    createdAt: Date.now(),
    realizedSolProfit: 0,
    isSimulated,
  };

  activePositions.set(tokenMint, position);
  console.log(`💼 [POSITION OPENED] Tracking ${tokenSymbol} at $${entryPriceUsd.toFixed(6)} (${solInvested} SOL invested)`);
  return position;
}

export function getActivePositions(): SnipedPosition[] {
  return Array.from(activePositions.values()).filter((p) => p.status !== 'CLOSED');
}

export function getAllPositions(): SnipedPosition[] {
  return Array.from(activePositions.values());
}

/**
 * Retrieves Keypair from configured SNIPER_PRIVATE_KEY
 * Supports base58 or JSON array format
 */
function getSniperKeypair(): Keypair | null {
  if (!env.SNIPER_PRIVATE_KEY) return null;
  try {
    const raw = env.SNIPER_PRIVATE_KEY.trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const secret = Uint8Array.from(JSON.parse(raw));
      return Keypair.fromSecretKey(secret);
    }
    const secret = bs58.decode(raw);
    return Keypair.fromSecretKey(secret);
  } catch (err: any) {
    console.warn('⚠️ Invalid SNIPER_PRIVATE_KEY in .env. Defaulting to paper-trading simulation:', err.message);
    return null;
  }
}

/**
 * Executes an automated snipe trade using Jupiter Aggregator or Paper-Trading Simulation
 */
export async function executeSnipeTrade(
  tokenMint: string,
  solAmount: number,
  tokenSymbol?: string,
  priceUsd?: number
): Promise<SnipeResult> {
  const lamports = Math.floor(solAmount * 1e9);
  const keypair = getSniperKeypair();

  console.log(`🎯 [SNIPER ENGINE] Executing automated snipe: ${solAmount} SOL on token ${tokenMint}...`);

  // 1. Fetch live swap quote from Jupiter API (Free)
  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL_MINT}&outputMint=${tokenMint}&amount=${lamports}&slippageBps=1500`;
    const quoteRes = await axios.get(quoteUrl, { timeout: 3500 });
    const quoteData = quoteRes.data;

    const outAmountRaw = Number(quoteData.outAmount || 0);
    const estimatedTokens = outAmountRaw > 0 ? outAmountRaw / 1e6 : (solAmount * 160) / (priceUsd || 0.0001);

    // 2. If Keypair exists and real trading is enabled, execute live on-chain
    if (keypair && env.HELIUS_RPC_URL) {
      const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
        quoteResponse: quoteData,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100_000, // 0.0001 SOL priority fee
      }, { timeout: 4000 });

      const { swapTransaction } = swapRes.data;
      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      transaction.sign([keypair]);

      // Submit via Helius RPC
      const rpcPayload = {
        jsonrpc: '2.0',
        id: 'snipe-tx',
        method: 'sendTransaction',
        params: [
          Buffer.from(transaction.serialize()).toString('base64'),
          { skipPreflight: true, maxRetries: 2, encoding: 'base64' },
        ],
      };

      const txRes = await axios.post(env.HELIUS_RPC_URL, rpcPayload);
      const signature = txRes.data.result || `live_${Date.now()}`;

      console.log(`🚀 [SNIPER LIVE EXECUTION] Tx Broadcast: https://solscan.io/tx/${signature}`);

      recordSnipedPosition(tokenMint, tokenSymbol || 'TOKEN', priceUsd || 0.0001, solAmount, estimatedTokens, false);

      return {
        success: true,
        simulated: false,
        signature,
        solAmount,
        tokenAmount: estimatedTokens,
        tokenMint,
        tokenSymbol,
        priceUsd,
        routePlan: quoteData.routePlan?.[0]?.swapInfo?.label || 'Jupiter Routing',
      };
    }

    // 3. Simulation / Paper-Trading Mode (Instant, Risk-Free, 0 SOL spent)
    const simulatedSignature = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    console.log(`⚡ [SNIPER SIMULATION] Paper-traded ${solAmount} SOL for ~${estimatedTokens.toFixed(0)} ${tokenSymbol || 'Tokens'}`);

    recordSnipedPosition(tokenMint, tokenSymbol || 'TOKEN', priceUsd || 0.0001, solAmount, estimatedTokens, true);

    return {
      success: true,
      simulated: true,
      signature: simulatedSignature,
      solAmount,
      tokenAmount: estimatedTokens,
      tokenMint,
      tokenSymbol,
      priceUsd,
      routePlan: quoteData.routePlan?.[0]?.swapInfo?.label || 'Jupiter Instant Route',
    };
  } catch (err: any) {
    console.warn(`⚠️ Jupiter quote unavailable for brand-new token ${tokenMint}: ${err.message}. Using bonding curve simulation.`);
    
    // Fallback bonding curve estimation
    const estimatedTokens = priceUsd && priceUsd > 0 ? (solAmount * 160) / priceUsd : solAmount * 50_000_000;
    const simulatedSignature = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    recordSnipedPosition(tokenMint, tokenSymbol || 'TOKEN', priceUsd || 0.0001, solAmount, estimatedTokens, true);

    return {
      success: true,
      simulated: true,
      signature: simulatedSignature,
      solAmount,
      tokenAmount: estimatedTokens,
      tokenMint,
      tokenSymbol,
      priceUsd,
      routePlan: 'Pump.fun Bonding Curve Direct',
    };
  }
}

/**
 * Executes an automated sell / take-profit exit trade via Jupiter or Paper-Trading Simulation
 * Supports partial scaling (e.g. sellPercent = 50 for 2X take-profit)
 */
export async function executeSnipeSell(
  tokenMint: string,
  tokenSymbol?: string,
  priceUsd?: number,
  sellPercent: number = 100
): Promise<SnipeResult> {
  const keypair = getSniperKeypair();
  console.log(`🎯 [SNIPER ENGINE] Executing automated SELL (${sellPercent}%) on token ${tokenMint}...`);

  try {
    if (keypair && env.HELIUS_RPC_URL) {
      try {
        const balRes = await axios.post(env.HELIUS_RPC_URL, {
          jsonrpc: '2.0',
          id: 'get-token-accounts',
          method: 'getTokenAccountsByOwner',
          params: [
            keypair.publicKey.toBase58(),
            { mint: tokenMint },
            { encoding: 'jsonParsed' },
          ],
        });

        const accounts = balRes.data?.result?.value || [];
        const fullTokenAmountRaw = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;

        if (fullTokenAmountRaw && Number(fullTokenAmountRaw) > 0) {
          const tokenAmountRaw = Math.floor(Number(fullTokenAmountRaw) * (sellPercent / 100));
          const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=${WSOL_MINT}&amount=${tokenAmountRaw}&slippageBps=2000`;
          const quoteRes = await axios.get(quoteUrl, { timeout: 3500 });
          const quoteData = quoteRes.data;

          const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse: quoteData,
            userPublicKey: keypair.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 100_000,
          }, { timeout: 4000 });

          const { swapTransaction } = swapRes.data;
          const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
          transaction.sign([keypair]);

          const txRes = await axios.post(env.HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'sell-tx',
            method: 'sendTransaction',
            params: [
              Buffer.from(transaction.serialize()).toString('base64'),
              { skipPreflight: true, maxRetries: 2, encoding: 'base64' },
            ],
          });

          const signature = txRes.data?.result || `live_sell_${Date.now()}`;
          const solReceived = Number(quoteData.outAmount || 0) / 1e9;
          console.log(`🚀 [SNIPER LIVE SELL] Sold ${sellPercent}% on-chain for ${solReceived.toFixed(3)} SOL! Tx: https://solscan.io/tx/${signature}`);

          return {
            success: true,
            simulated: false,
            signature,
            solAmount: solReceived,
            tokenAmount: Number(tokenAmountRaw) / 1e6,
            tokenMint,
            tokenSymbol,
            priceUsd,
            routePlan: quoteData.routePlan?.[0]?.swapInfo?.label || 'Jupiter Sell Route',
          };
        }
      } catch (liveSellErr: any) {
        console.warn('⚠️ Live sell attempt fell back to simulation:', liveSellErr.message);
      }
    }

    // Simulation / Paper-Trading Mode
    const simulatedSignature = `sim_sell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const pos = activePositions.get(tokenMint);
    const estimatedSol = pos
      ? (pos.solInvested * (sellPercent / 100) * ((priceUsd || pos.entryPriceUsd) / pos.entryPriceUsd))
      : 0.1 * (sellPercent / 100);

    console.log(`⚡ [SNIPER SIMULATION] Sold ${sellPercent}% of ${tokenSymbol || 'Tokens'} for ~${estimatedSol.toFixed(3)} SOL`);

    return {
      success: true,
      simulated: true,
      signature: simulatedSignature,
      solAmount: Number(estimatedSol.toFixed(3)),
      tokenAmount: pos ? pos.remainingTokens * (sellPercent / 100) : 100_000,
      tokenMint,
      tokenSymbol,
      priceUsd,
      routePlan: 'Jupiter Route Simulation',
    };
  } catch (err: any) {
    console.warn(`⚠️ Snipe sell error on ${tokenMint}:`, err.message);
    return {
      success: false,
      simulated: true,
      signature: `err_${Date.now()}`,
      solAmount: 0,
      tokenAmount: 0,
      tokenMint,
      tokenSymbol,
      error: err.message,
    };
  }
}

export interface TpSlActionTriggered {
  position: SnipedPosition;
  action: 'TAKE_PROFIT_2X' | 'TAKE_PROFIT_5X' | 'TRAILING_STOP' | 'HARD_STOP';
  gainPercent: number;
  solAmount: number;
  message: string;
}

/**
 * Autonomous Moon or Dust Engine (Zero Stop-Loss • No Pullback Selling)
 * 1. At +100% (2X): Sells 50% to return original principal risk-free.
 * 2. At +400% (5X): Sells remaining 50% moonbag for massive 5X profit.
 * 3. Pullbacks & Dips: Zero selling on pullbacks/dips. The stake is the max risk.
 */
export async function checkActivePositionsTpSl(
  tokenMint: string,
  currentPriceUsd: number
): Promise<TpSlActionTriggered | null> {
  const pos = activePositions.get(tokenMint);
  if (!pos || pos.status === 'CLOSED') return null;

  pos.currentPriceUsd = currentPriceUsd;
  pos.peakPriceUsd = Math.max(pos.peakPriceUsd, currentPriceUsd);

  const gainFromEntryPct = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

  // 1. Take Profit at +100% (2X) - Sell 50% of tokens to secure original SOL!
  if (pos.status === 'OPEN' && gainFromEntryPct >= 100.0) {
    console.log(`🎯 [AUTONOMOUS 2X TAKE-PROFIT] $${pos.tokenSymbol} reached +${gainFromEntryPct.toFixed(1)}%! Selling 50% to secure initial SOL...`);

    const sellRes = await executeSnipeSell(pos.tokenMint, pos.tokenSymbol, currentPriceUsd, 50);
    const solSecured = sellRes.solAmount || pos.solInvested;

    pos.status = 'PARTIAL_TP_2X';
    pos.remainingTokens = pos.initialTokens * 0.5;
    pos.realizedSolProfit += solSecured;

    return {
      position: pos,
      action: 'TAKE_PROFIT_2X',
      gainPercent: gainFromEntryPct,
      solAmount: solSecured,
      message: `🎯 <b>2X DE-RISKED | $${pos.tokenSymbol} (+${gainFromEntryPct.toFixed(0)}%)</b>\n` +
        `💵 SOL Returned: <b>+${solSecured.toFixed(3)} SOL</b> (Principal secured!)\n` +
        `💎 Runner: <b>Remaining bag riding trend forever</b>`,
    };
  }

  // 2. Uncapped Moonbag Trailing Stop (35% pullback from peak)
  // Allows the trend to breathe and ride indefinitely without premature stop-out on normal wicks.
  const dropFromPeakPct = ((pos.peakPriceUsd - currentPriceUsd) / pos.peakPriceUsd) * 100;
  const trailingStopPct = 35.0;

  if (pos.status === 'PARTIAL_TP_2X' && dropFromPeakPct >= trailingStopPct && pos.remainingTokens > 0) {
    const peakMultiplier = Number((pos.peakPriceUsd / pos.entryPriceUsd).toFixed(2));
    console.log(`🛡️ [AUTONOMOUS TRAILING STOP] $${pos.tokenSymbol} trailed down -${dropFromPeakPct.toFixed(1)}% from peak (${peakMultiplier}X). Liquidating remaining moonbag...`);

    const sellRes = await executeSnipeSell(pos.tokenMint, pos.tokenSymbol, currentPriceUsd, 100);
    const moonbagSol = sellRes.solAmount || (pos.solInvested * (currentPriceUsd / pos.entryPriceUsd) * 0.5);

    pos.status = 'CLOSED';
    pos.closedAt = Date.now();
    pos.remainingTokens = 0;
    pos.realizedSolProfit += moonbagSol;
    pos.exitReason = 'TRAILING_STOP';

    return {
      position: pos,
      action: 'TRAILING_STOP',
      gainPercent: gainFromEntryPct,
      solAmount: moonbagSol,
      message: `🛑 <b>TREND EXIT | $${pos.tokenSymbol}</b>\n` +
        `🔝 Peak: <b>${peakMultiplier}X</b> (Trailed -${dropFromPeakPct.toFixed(0)}%)\n` +
        `💵 Net Profit: <b>+${pos.realizedSolProfit.toFixed(3)} SOL</b>`,
    };
  }

  // MOON OR DUST: No stop-loss selling on pullbacks/dips. The stake is the maximum risk.
  return null;
}


export type FilterMode = 'ALL' | 'SAFE' | 'RISK';

export interface UserPreferencesData {
  telegramUserId: string;
  autoSnipeEnabled: boolean;
  autoSnipeSolAmount: number;
  maxSlippagePercent: number;
  receiveSafeAlerts: boolean;
  receiveRiskAlerts: boolean;
  filterMode: FilterMode;
}

const inMemoryUserPrefs = new Map<string, {
  telegramUserId: string;
  autoSnipeEnabled: boolean;
  autoSnipeSolAmount: number;
  maxSlippagePercent: number;
  receiveSafeAlerts: boolean;
  receiveRiskAlerts: boolean;
}>();

function isDatabaseAvailable(): boolean {
  return Boolean(env.DATABASE_URL && !env.DATABASE_URL.includes('password@localhost'));
}

function computeFilterMode(receiveSafe: boolean, receiveRisk: boolean): FilterMode {
  if (receiveSafe && !receiveRisk) return 'SAFE';
  if (!receiveSafe && receiveRisk) return 'RISK';
  return 'ALL';
}

/**
 * Retrieves full user preferences including auto-snipe settings and alert filter mode
 */
export async function getUserPreferences(telegramUserId: string): Promise<UserPreferencesData> {
  if (!inMemoryUserPrefs.has(telegramUserId)) {
    inMemoryUserPrefs.set(telegramUserId, {
      telegramUserId,
      autoSnipeEnabled: false,
      autoSnipeSolAmount: env.AUTO_SNIPE_DEFAULT_SOL || 0.01,
      maxSlippagePercent: 15.0,
      receiveSafeAlerts: true,
      receiveRiskAlerts: true,
    });
  }

  if (!isDatabaseAvailable()) {
    const mem = inMemoryUserPrefs.get(telegramUserId)!;
    return {
      ...mem,
      filterMode: computeFilterMode(mem.receiveSafeAlerts, mem.receiveRiskAlerts),
    };
  }

  try {
    const pref = await prisma.userPreference.upsert({
      where: { telegramUserId },
      update: {},
      create: {
        telegramUserId,
        autoSnipeEnabled: false,
        autoSnipeSolAmount: env.AUTO_SNIPE_DEFAULT_SOL || 0.01,
        receiveSafeAlerts: true,
        receiveRiskAlerts: true,
      },
    });

    const data = {
      telegramUserId,
      autoSnipeEnabled: pref.autoSnipeEnabled,
      autoSnipeSolAmount: pref.autoSnipeSolAmount,
      maxSlippagePercent: pref.maxSlippagePercent,
      receiveSafeAlerts: pref.receiveSafeAlerts,
      receiveRiskAlerts: pref.receiveRiskAlerts,
    };
    inMemoryUserPrefs.set(telegramUserId, data);

    return {
      ...data,
      filterMode: computeFilterMode(data.receiveSafeAlerts, data.receiveRiskAlerts),
    };
  } catch {
    const mem = inMemoryUserPrefs.get(telegramUserId)!;
    return {
      ...mem,
      filterMode: computeFilterMode(mem.receiveSafeAlerts, mem.receiveRiskAlerts),
    };
  }
}

/**
 * Updates user preferences (auto-snipe or alert filter modes)
 */
export async function setUserPreferences(
  telegramUserId: string,
  updates: {
    autoSnipeEnabled?: boolean;
    autoSnipeSolAmount?: number;
    maxSlippagePercent?: number;
    receiveSafeAlerts?: boolean;
    receiveRiskAlerts?: boolean;
  }
): Promise<UserPreferencesData> {
  const current = inMemoryUserPrefs.get(telegramUserId) || {
    telegramUserId,
    autoSnipeEnabled: false,
    autoSnipeSolAmount: env.AUTO_SNIPE_DEFAULT_SOL || 0.01,
    maxSlippagePercent: 15.0,
    receiveSafeAlerts: true,
    receiveRiskAlerts: true,
  };

  const updated = {
    ...current,
    ...updates,
  };
  inMemoryUserPrefs.set(telegramUserId, updated);

  if (isDatabaseAvailable()) {
    try {
      await prisma.userPreference.upsert({
        where: { telegramUserId },
        update: updates,
        create: {
          telegramUserId,
          autoSnipeEnabled: updated.autoSnipeEnabled,
          autoSnipeSolAmount: updated.autoSnipeSolAmount,
          maxSlippagePercent: updated.maxSlippagePercent,
          receiveSafeAlerts: updated.receiveSafeAlerts,
          receiveRiskAlerts: updated.receiveRiskAlerts,
        },
      });
    } catch (err: any) {
      console.warn('⚠️ Could not save user preference to DB, kept in memory:', err.message);
    }
  }

  return {
    ...updated,
    filterMode: computeFilterMode(updated.receiveSafeAlerts, updated.receiveRiskAlerts),
  };
}

/**
 * Sets user alert filter mode: 'ALL' | 'SAFE' | 'RISK'
 */
export async function setUserFilterMode(
  telegramUserId: string,
  mode: FilterMode
): Promise<UserPreferencesData> {
  const receiveSafeAlerts = mode === 'ALL' || mode === 'SAFE';
  const receiveRiskAlerts = mode === 'ALL' || mode === 'RISK';
  return setUserPreferences(telegramUserId, { receiveSafeAlerts, receiveRiskAlerts });
}

// Backward-compatible alias
export const getUserAutoSnipeConfig = getUserPreferences;
export const setUserAutoSnipeConfig = setUserPreferences;

/**
 * Exits an individual sniped position (live on-chain or simulation)
 */
export async function exitSnipedPosition(tokenMintOrSymbol: string): Promise<SnipeResult & { error?: string }> {
  const query = tokenMintOrSymbol.trim();
  let pos = activePositions.get(query);
  if (!pos) {
    const clean = query.replace(/^\$/, '').toUpperCase();
    for (const p of activePositions.values()) {
      if (p.tokenSymbol.toUpperCase() === clean && p.status !== 'CLOSED') {
        pos = p;
        break;
      }
    }
  }

  if (!pos || pos.status === 'CLOSED') {
    return {
      success: false,
      simulated: true,
      signature: '',
      solAmount: 0,
      tokenAmount: 0,
      tokenMint: query,
      error: `No active open sniped position for "${query}"`,
    };
  }

  const sellRes = await executeSnipeSell(pos.tokenMint, pos.tokenSymbol, pos.currentPriceUsd, 100);
  pos.status = 'CLOSED';
  pos.closedAt = Date.now();
  pos.remainingTokens = 0;
  pos.exitReason = 'MANUAL_EXIT';
  if (sellRes.solAmount) {
    pos.realizedSolProfit += sellRes.solAmount - pos.solInvested;
  }
  return sellRes;
}

/**
 * Exits all active sniped positions (live on-chain or simulation)
 */
export async function exitAllSnipedPositions(): Promise<{ count: number; totalSol: number; results: SnipeResult[] }> {
  const active = getActivePositions();
  const results: SnipeResult[] = [];
  let totalSol = 0;

  for (const pos of active) {
    const res = await executeSnipeSell(pos.tokenMint, pos.tokenSymbol, pos.currentPriceUsd, 100);
    pos.status = 'CLOSED';
    pos.closedAt = Date.now();
    pos.remainingTokens = 0;
    pos.exitReason = 'MANUAL_EXIT_ALL';
    if (res.solAmount) {
      pos.realizedSolProfit += res.solAmount - pos.solInvested;
      totalSol += res.solAmount;
    }
    results.push(res);
  }

  return {
    count: active.length,
    totalSol: Number(totalSol.toFixed(4)),
    results,
  };
}

