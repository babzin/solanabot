import fs from 'fs';
import path from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { env } from '../config/env.js';
import { redis } from './redis.js';
import { prisma } from './db.js';

const ADMIN_CONFIG_FILE = path.join(process.cwd(), 'data', 'admin_config.json');
const REDIS_KEY_ADMIN_CONFIG = 'solana_bot:admin_config';

export interface FeeTransferRecord {
  id: string;
  timestamp: string;
  signature: string;
  amountSol: number;
  amountUsd?: number;
  destination: string;
  feeType: 'ENTRY_FEE_1PCT' | 'PROFIT_FEE_15PCT' | 'SWEEP';
  isLive: boolean;
  userId?: string;
  tokenMint?: string;
}

export interface AdminConfigState {
  adminFeeWallet: string | null;
  totalLiveFeesSol: number;
  totalLiveFeesUsd: number;
  entryFeesSol: number;
  entryFeesUsd: number;
  profitFeesSol: number;
  profitFeesUsd: number;
  totalModelFeesUsd: number;
  totalModelFeesSol: number;
  totalTransferredSol: number;
  transferHistory: FeeTransferRecord[];
  lastUpdated: string;
}

let cachedAdminConfig: AdminConfigState = {
  adminFeeWallet: null,
  totalLiveFeesSol: 0,
  totalLiveFeesUsd: 0,
  entryFeesSol: 0,
  entryFeesUsd: 0,
  profitFeesSol: 0,
  profitFeesUsd: 0,
  totalModelFeesUsd: 0,
  totalModelFeesSol: 0,
  totalTransferredSol: 0,
  transferHistory: [],
  lastUpdated: new Date().toISOString(),
};

/**
 * Loads admin configuration from Redis or local JSON backup
 */
export async function initAdminConfig(): Promise<void> {
  // 1. Try local disk
  try {
    if (fs.existsSync(ADMIN_CONFIG_FILE)) {
      const raw = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf-8');
      if (raw) {
        cachedAdminConfig = { ...cachedAdminConfig, ...JSON.parse(raw) };
      }
    }
  } catch (err: any) {
    console.warn('⚠️ Could not load admin_config.json from disk:', err.message);
  }

  // 2. Try Redis
  try {
    if (redis && redis.status === 'ready') {
      const rawRedis = await redis.get(REDIS_KEY_ADMIN_CONFIG);
      if (rawRedis) {
        cachedAdminConfig = { ...cachedAdminConfig, ...JSON.parse(rawRedis) };
      }
    }
  } catch {}
}

// Auto-initialize on module load
initAdminConfig().catch(() => {});

/**
 * Persists admin config to disk and Redis
 */
export async function persistAdminConfig(): Promise<void> {
  cachedAdminConfig.lastUpdated = new Date().toISOString();
  try {
    const dir = path.dirname(ADMIN_CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cachedAdminConfig, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('⚠️ Could not write admin_config.json:', err.message);
  }

  try {
    if (redis && redis.status === 'ready') {
      await redis.set(REDIS_KEY_ADMIN_CONFIG, JSON.stringify(cachedAdminConfig));
    }
  } catch {}
}

/**
 * Validates a Solana public address
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the currently configured Admin Fee destination wallet
 */
export function getAdminFeeWallet(): string | null {
  return cachedAdminConfig.adminFeeWallet || null;
}

/**
 * Sets the Admin Fee destination wallet where all bot fees will be routed
 */
export async function setAdminFeeWallet(walletAddress: string): Promise<{ success: boolean; error?: string }> {
  const trimmed = walletAddress.trim();
  if (!isValidSolanaAddress(trimmed)) {
    return { success: false, error: 'Invalid Solana address format. Address must be 32-44 base58 characters.' };
  }

  cachedAdminConfig.adminFeeWallet = trimmed;
  await persistAdminConfig();
  console.log(`✅ [ADMIN CONFIG] Admin fee destination wallet set to: ${trimmed}`);
  return { success: true };
}

/**
 * Records fee revenue earned from user trades (Live or Model)
 */
export async function recordFeeRevenue(params: {
  feeType: 'ENTRY_FEE_1PCT' | 'PROFIT_FEE_15PCT';
  solAmount: number;
  usdAmount: number;
  isLive: boolean;
  userId?: string;
  tokenMint?: string;
  signature?: string;
}): Promise<void> {
  const { feeType, solAmount, usdAmount, isLive, userId, tokenMint, signature } = params;

  if (isLive) {
    cachedAdminConfig.totalLiveFeesSol = Number((cachedAdminConfig.totalLiveFeesSol + solAmount).toFixed(6));
    cachedAdminConfig.totalLiveFeesUsd = Number((cachedAdminConfig.totalLiveFeesUsd + usdAmount).toFixed(2));

    if (feeType === 'ENTRY_FEE_1PCT') {
      cachedAdminConfig.entryFeesSol = Number((cachedAdminConfig.entryFeesSol + solAmount).toFixed(6));
      cachedAdminConfig.entryFeesUsd = Number((cachedAdminConfig.entryFeesUsd + usdAmount).toFixed(2));
    } else {
      cachedAdminConfig.profitFeesSol = Number((cachedAdminConfig.profitFeesSol + solAmount).toFixed(6));
      cachedAdminConfig.profitFeesUsd = Number((cachedAdminConfig.profitFeesUsd + usdAmount).toFixed(2));
    }
  } else {
    cachedAdminConfig.totalModelFeesSol = Number((cachedAdminConfig.totalModelFeesSol + solAmount).toFixed(6));
    cachedAdminConfig.totalModelFeesUsd = Number((cachedAdminConfig.totalModelFeesUsd + usdAmount).toFixed(2));
  }

  if (signature) {
    cachedAdminConfig.transferHistory.unshift({
      id: `fee_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      signature,
      amountSol: solAmount,
      amountUsd: usdAmount,
      destination: cachedAdminConfig.adminFeeWallet || 'PENDING_CONFIG',
      feeType,
      isLive,
      userId,
      tokenMint,
    });
    if (cachedAdminConfig.transferHistory.length > 50) {
      cachedAdminConfig.transferHistory = cachedAdminConfig.transferHistory.slice(0, 50);
    }
  }

  await persistAdminConfig();
}

/**
 * Executes an on-chain transfer of collected SOL fees to the admin fee wallet
 */
export async function dispatchFeeTransferOnChain(
  fromKeypair: Keypair,
  amountSol: number,
  feeType: 'ENTRY_FEE_1PCT' | 'PROFIT_FEE_15PCT' | 'SWEEP',
  metadata?: { userId?: string; tokenMint?: string }
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const destination = cachedAdminConfig.adminFeeWallet;
  if (!destination) {
    return { success: false, error: 'No admin fee wallet configured.' };
  }

  const rpcUrl = env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    const destPubkey = new PublicKey(destination);
    const balanceLamports = await connection.getBalance(fromKeypair.publicKey);
    const feeBufferLamports = 10_000; // 0.00001 SOL buffer for network gas

    const transferLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    if (transferLamports <= 0 || balanceLamports < transferLamports + feeBufferLamports) {
      return {
        success: false,
        error: `Insufficient balance for fee transfer. Balance: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, Requested: ${amountSol.toFixed(4)} SOL`,
      };
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: fromKeypair.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: destPubkey,
        lamports: transferLamports,
      })
    );

    transaction.sign(fromKeypair);
    const rawTx = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTx, { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');

    cachedAdminConfig.totalTransferredSol = Number(
      (cachedAdminConfig.totalTransferredSol + amountSol).toFixed(6)
    );

    cachedAdminConfig.transferHistory.unshift({
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      signature,
      amountSol,
      destination,
      feeType,
      isLive: true,
      userId: metadata?.userId,
      tokenMint: metadata?.tokenMint,
    });

    if (cachedAdminConfig.transferHistory.length > 50) {
      cachedAdminConfig.transferHistory = cachedAdminConfig.transferHistory.slice(0, 50);
    }

    await persistAdminConfig();
    console.log(
      `💸 [ADMIN FEE TRANSFERRED] ${amountSol.toFixed(4)} SOL (${feeType}) routed to ${destination}. Tx: https://solscan.io/tx/${signature}`
    );
    return { success: true, signature };
  } catch (err: any) {
    console.warn(`⚠️ Fee transfer on-chain notice:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Sweeps all accumulated SOL from the default server keypair to the admin fee wallet
 */
export async function sweepServerFeesToAdmin(): Promise<{
  success: boolean;
  solTransferred: number;
  signature?: string;
  error?: string;
}> {
  const destination = cachedAdminConfig.adminFeeWallet;
  if (!destination) {
    return { success: false, solTransferred: 0, error: 'No admin fee wallet configured. Please set a fee wallet first.' };
  }

  const { getServerKeypair } = await import('./sniper.js');
  const serverKey = getServerKeypair();
  if (!serverKey) {
    return { success: false, solTransferred: 0, error: 'Server wallet keypair is not configured on this instance.' };
  }
  const rpcUrl = env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    const destPubkey = new PublicKey(destination);
    const balanceLamports = await connection.getBalance(serverKey.publicKey);
    const feeBufferLamports = 15_000; // 0.000015 SOL buffer

    const sweepLamports = balanceLamports - feeBufferLamports;
    if (sweepLamports <= 0) {
      const curBal = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
      return { success: false, solTransferred: 0, error: `Server wallet has ${curBal} SOL, which is below the minimum sweep threshold.` };
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: serverKey.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: serverKey.publicKey,
        toPubkey: destPubkey,
        lamports: sweepLamports,
      })
    );

    transaction.sign(serverKey);
    const rawTx = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTx, { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');

    const solTransferred = Number((sweepLamports / LAMPORTS_PER_SOL).toFixed(4));
    cachedAdminConfig.totalTransferredSol = Number(
      (cachedAdminConfig.totalTransferredSol + solTransferred).toFixed(6)
    );

    cachedAdminConfig.transferHistory.unshift({
      id: `sweep_${Date.now()}`,
      timestamp: new Date().toISOString(),
      signature,
      amountSol: solTransferred,
      destination,
      feeType: 'SWEEP',
      isLive: true,
    });

    await persistAdminConfig();
    return { success: true, solTransferred, signature };
  } catch (err: any) {
    return { success: false, solTransferred: 0, error: err.message };
  }
}

export interface AdminAnalyticsSummary {
  totalUsers: number;
  activeUsers: number;
  fundedUsersCount: number;
  autoSnipeUsersCount: number;
  unfundedUsersCount: number;
  totalLiveFeesSol: number;
  totalLiveFeesUsd: number;
  entryFeesSol: number;
  entryFeesUsd: number;
  profitFeesSol: number;
  profitFeesUsd: number;
  totalModelFeesUsd: number;
  totalModelFeesSol: number;
  totalTransferredSol: number;
  adminFeeWallet: string | null;
  serverWalletAddress: string;
  serverWalletBalanceSol: number;
  transferHistory: FeeTransferRecord[];
}

/**
 * Calculates comprehensive Admin Business Intelligence and fee metrics
 */
export async function getAdminAnalyticsSummary(): Promise<AdminAnalyticsSummary> {
  const { inMemoryUserPrefs, getServerKeypair, inMemoryUserPositions } = await import('./sniper.js');
  const { fetchUserSolBalance } = await import('./telegram.js');

  // 1. Gather all unique users from database and in-memory caches
  const allUserIds = new Set<string>();
  try {
    const dbUsers = await prisma.userPreference.findMany({ select: { telegramUserId: true } });
    for (const u of dbUsers) {
      if (u.telegramUserId) allUserIds.add(u.telegramUserId);
    }
  } catch {}

  for (const k of inMemoryUserPrefs.keys()) {
    allUserIds.add(k);
  }
  for (const k of inMemoryUserPositions.keys()) {
    allUserIds.add(k);
  }

  const totalUsers = Math.max(allUserIds.size, 1);

  // 2. Count active users, funded wallets, auto-snipe enabled
  let fundedUsersCount = 0;
  let autoSnipeUsersCount = 0;
  let activeUsersCount = 0;

  for (const uid of allUserIds) {
    const pref = inMemoryUserPrefs.get(uid);
    let hasWallet = Boolean(pref?.solanaWallet);
    let autoSnipeOn = Boolean(pref?.autoSnipeEnabled);

    if (autoSnipeOn) autoSnipeUsersCount++;
    if (hasWallet) {
      fundedUsersCount++;
    }

    const positions = inMemoryUserPositions.get(uid) || [];
    if (hasWallet || autoSnipeOn || positions.length > 0) {
      activeUsersCount++;
    }
  }

  // Ensure activeUsers is at least 1 if admin or model is running
  activeUsersCount = Math.max(activeUsersCount, 1);
  const unfundedUsersCount = Math.max(0, totalUsers - fundedUsersCount);

  // 3. Server wallet balance
  const serverKey = getServerKeypair();
  const serverWalletAddress = serverKey ? serverKey.publicKey.toBase58() : 'N/A';
  let serverWalletBalanceSol = 0;
  if (serverKey) {
    try {
      serverWalletBalanceSol = await fetchUserSolBalance(serverWalletAddress);
    } catch {}
  }

  return {
    totalUsers,
    activeUsers: activeUsersCount,
    fundedUsersCount,
    autoSnipeUsersCount,
    unfundedUsersCount,
    totalLiveFeesSol: cachedAdminConfig.totalLiveFeesSol,
    totalLiveFeesUsd: cachedAdminConfig.totalLiveFeesUsd,
    entryFeesSol: cachedAdminConfig.entryFeesSol,
    entryFeesUsd: cachedAdminConfig.entryFeesUsd,
    profitFeesSol: cachedAdminConfig.profitFeesSol,
    profitFeesUsd: cachedAdminConfig.profitFeesUsd,
    totalModelFeesUsd: cachedAdminConfig.totalModelFeesUsd,
    totalModelFeesSol: cachedAdminConfig.totalModelFeesSol,
    totalTransferredSol: cachedAdminConfig.totalTransferredSol,
    adminFeeWallet: cachedAdminConfig.adminFeeWallet,
    serverWalletAddress,
    serverWalletBalanceSol,
    transferHistory: cachedAdminConfig.transferHistory.slice(0, 5),
  };
}

