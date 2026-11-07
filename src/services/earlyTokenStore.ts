import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { redis } from './redis.js';
import { prisma } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const BACKUP_FILE = path.join(DATA_DIR, 'early_tokens.json');
const REDIS_KEY_TRACKED_TOKENS = 'soul:tracked_early_tokens';

// Ensure data backup directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch {}

export interface TrackedTokenRecord {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  pairAddress?: string;
  dexUrl?: string;
  imageUrl?: string | null;
  pairCreatedAt?: number | bigint | null;
  ageMinutes?: number;
  liquidityUsd?: number;
  volume1h?: number;
  holderCount?: number;
  top20Pct?: number;
  devHoldingPct?: number;
  xUrl?: string;
  webUrl?: string;
  tgUrl?: string;
  entryPriceUsd: number;
  entryMarketCap: number;
  peakPriceUsd: number;
  lowestPriceUsd: number;
  lastAlertedPriceUsd: number;
  lastMilestonePct: number;
  lastDipMilestonePct: number;
  status: 'ACTIVE' | 'GRADUATED' | 'STOPPED';
  alertDate: string;
  whaleSolAmount?: number;
  dailyQuotaIndex: number;
  slmSignal?: 'GO' | 'NO_GO';
  createdAt: string;
  updatedAt: string;
}

// In-memory store for 0ms access
const trackedTokensMap = new Map<string, TrackedTokenRecord>();
let isHydrated = false;

/**
 * Hydrates tokens from Redis, disk, or Prisma on startup
 */
export async function hydrateTrackedTokens(): Promise<void> {
  if (isHydrated) return;

  // 1. Try Redis
  try {
    const raw = await redis.get(REDIS_KEY_TRACKED_TOKENS);
    if (raw) {
      const parsed: TrackedTokenRecord[] = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          trackedTokensMap.set(t.tokenMint, t);
        }
        console.log(`✅ [Token Store] Loaded ${trackedTokensMap.size} tracked tokens from Redis.`);
        isHydrated = true;
        return;
      }
    }
  } catch (err: any) {
    console.warn('⚠️ [Token Store] Redis load notice:', err.message);
  }

  // 2. Fallback to Disk JSON
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const data = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const parsed: TrackedTokenRecord[] = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          trackedTokensMap.set(t.tokenMint, t);
        }
        console.log(`✅ [Token Store] Loaded ${trackedTokensMap.size} tracked tokens from disk backup.`);
        isHydrated = true;
        return;
      }
    }
  } catch {}

  // 3. Fallback to Prisma if database is reachable
  try {
    const dbTokens = await prisma.earlyTrendingToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (dbTokens && dbTokens.length > 0) {
      for (const t of dbTokens) {
        trackedTokensMap.set(t.tokenMint, {
          id: t.id,
          tokenMint: t.tokenMint,
          tokenSymbol: t.tokenSymbol,
          tokenName: t.tokenName,
          pairAddress: t.pairAddress || undefined,
          dexUrl: t.dexUrl || undefined,
          imageUrl: t.imageUrl,
          pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
          ageMinutes: t.ageMinutes || undefined,
          liquidityUsd: t.liquidityUsd || undefined,
          volume1h: t.volume1h || undefined,
          holderCount: t.holderCount || undefined,
          top20Pct: t.top20Pct || undefined,
          devHoldingPct: t.devHoldingPct || undefined,
          xUrl: t.xUrl || undefined,
          webUrl: t.webUrl || undefined,
          tgUrl: t.tgUrl || undefined,
          entryPriceUsd: t.entryPriceUsd,
          entryMarketCap: t.entryMarketCap,
          peakPriceUsd: t.peakPriceUsd,
          lowestPriceUsd: t.lowestPriceUsd,
          lastAlertedPriceUsd: t.lastAlertedPriceUsd,
          lastMilestonePct: t.lastMilestonePct,
          lastDipMilestonePct: t.lastDipMilestonePct,
          status: (t.status as any) || 'ACTIVE',
          alertDate: t.alertDate,
          whaleSolAmount: t.whaleSolAmount || undefined,
          dailyQuotaIndex: t.dailyQuotaIndex,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        });
      }
      console.log(`✅ [Token Store] Synced ${trackedTokensMap.size} tokens from PostgreSQL.`);
    }
  } catch {}

  isHydrated = true;
}

/**
 * Persists the current token store to Redis and disk
 */
async function persistTokens(): Promise<void> {
  const tokenList = Array.from(trackedTokensMap.values());

  // 1. Write to Disk
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(tokenList, null, 2), 'utf-8');
  } catch {}

  // 2. Write to Redis (only if connected and ready)
  if (redis.status === 'ready') {
    try {
      await redis.set(REDIS_KEY_TRACKED_TOKENS, JSON.stringify(tokenList));
    } catch {}
  }
}

/**
 * Saves a new alerted token (whether GO or NO_GO)
 */
export async function saveAlertedToken(token: TrackedTokenRecord): Promise<void> {
  await hydrateTrackedTokens();
  trackedTokensMap.set(token.tokenMint, token);
  await persistTokens();

  // Try Prisma (non-blocking)
  try {
    await prisma.earlyTrendingToken.upsert({
      where: { tokenMint: token.tokenMint },
      create: {
        tokenMint: token.tokenMint,
        pairAddress: token.pairAddress,
        dexUrl: token.dexUrl,
        imageUrl: token.imageUrl,
        pairCreatedAt: token.pairCreatedAt ? BigInt(token.pairCreatedAt) : null,
        ageMinutes: token.ageMinutes,
        liquidityUsd: token.liquidityUsd,
        volume1h: token.volume1h,
        holderCount: token.holderCount,
        top20Pct: token.top20Pct,
        devHoldingPct: token.devHoldingPct,
        xUrl: token.xUrl,
        webUrl: token.webUrl,
        tgUrl: token.tgUrl,
        tokenSymbol: token.tokenSymbol,
        tokenName: token.tokenName,
        entryPriceUsd: token.entryPriceUsd,
        entryMarketCap: token.entryMarketCap,
        peakPriceUsd: token.peakPriceUsd,
        lowestPriceUsd: token.lowestPriceUsd,
        lastAlertedPriceUsd: token.lastAlertedPriceUsd,
        lastMilestonePct: token.lastMilestonePct,
        lastDipMilestonePct: token.lastDipMilestonePct,
        status: token.status,
        alertDate: token.alertDate,
        whaleSolAmount: token.whaleSolAmount,
        dailyQuotaIndex: token.dailyQuotaIndex,
      },
      update: {
        lastAlertedPriceUsd: token.lastAlertedPriceUsd,
        peakPriceUsd: token.peakPriceUsd,
        lowestPriceUsd: token.lowestPriceUsd,
        lastMilestonePct: token.lastMilestonePct,
        lastDipMilestonePct: token.lastDipMilestonePct,
      },
    });
  } catch {}
}

/**
 * Retrieves a single tracked token record by mint address with database & disk fallback
 */
export async function getTrackedToken(tokenMint: string): Promise<TrackedTokenRecord | null> {
  await hydrateTrackedTokens();
  try {
    const dbToken = await prisma.earlyTrendingToken.findUnique({
      where: { tokenMint },
    });
    if (dbToken) {
      return {
        id: dbToken.id,
        tokenMint: dbToken.tokenMint,
        tokenSymbol: dbToken.tokenSymbol,
        tokenName: dbToken.tokenName,
        pairAddress: dbToken.pairAddress || undefined,
        dexUrl: dbToken.dexUrl || undefined,
        imageUrl: dbToken.imageUrl,
        pairCreatedAt: dbToken.pairCreatedAt ? Number(dbToken.pairCreatedAt) : null,
        ageMinutes: dbToken.ageMinutes || undefined,
        liquidityUsd: dbToken.liquidityUsd || undefined,
        volume1h: dbToken.volume1h || undefined,
        holderCount: dbToken.holderCount || undefined,
        top20Pct: dbToken.top20Pct || undefined,
        devHoldingPct: dbToken.devHoldingPct || undefined,
        xUrl: dbToken.xUrl || undefined,
        webUrl: dbToken.webUrl || undefined,
        tgUrl: dbToken.tgUrl || undefined,
        entryPriceUsd: dbToken.entryPriceUsd,
        entryMarketCap: dbToken.entryMarketCap,
        peakPriceUsd: dbToken.peakPriceUsd,
        lowestPriceUsd: dbToken.lowestPriceUsd,
        lastAlertedPriceUsd: dbToken.lastAlertedPriceUsd,
        lastMilestonePct: dbToken.lastMilestonePct,
        lastDipMilestonePct: dbToken.lastDipMilestonePct,
        status: dbToken.status as any,
        alertDate: dbToken.alertDate,
        whaleSolAmount: dbToken.whaleSolAmount || undefined,
        dailyQuotaIndex: dbToken.dailyQuotaIndex,
        slmSignal: (dbToken as any).slmSignal || undefined,
        createdAt: dbToken.createdAt.toISOString(),
        updatedAt: dbToken.updatedAt.toISOString(),
      };
    }
  } catch {}
  return trackedTokensMap.get(tokenMint) || null;
}

/**
 * Returns all tokens currently being tracked for price milestones & dips
 */
export async function getActiveTrackedTokens(): Promise<TrackedTokenRecord[]> {
  await hydrateTrackedTokens();

  // Merge any active tokens from DB if reachable
  try {
    const dbTokens = await prisma.earlyTrendingToken.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    for (const t of dbTokens) {
      if (!trackedTokensMap.has(t.tokenMint)) {
        trackedTokensMap.set(t.tokenMint, {
          id: t.id,
          tokenMint: t.tokenMint,
          tokenSymbol: t.tokenSymbol,
          tokenName: t.tokenName,
          pairAddress: t.pairAddress || undefined,
          dexUrl: t.dexUrl || undefined,
          imageUrl: t.imageUrl,
          pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
          ageMinutes: t.ageMinutes || undefined,
          liquidityUsd: t.liquidityUsd || undefined,
          volume1h: t.volume1h || undefined,
          holderCount: t.holderCount || undefined,
          top20Pct: t.top20Pct || undefined,
          devHoldingPct: t.devHoldingPct || undefined,
          xUrl: t.xUrl || undefined,
          webUrl: t.webUrl || undefined,
          tgUrl: t.tgUrl || undefined,
          entryPriceUsd: t.entryPriceUsd,
          entryMarketCap: t.entryMarketCap,
          peakPriceUsd: t.peakPriceUsd,
          lowestPriceUsd: t.lowestPriceUsd,
          lastAlertedPriceUsd: t.lastAlertedPriceUsd,
          lastMilestonePct: t.lastMilestonePct,
          lastDipMilestonePct: t.lastDipMilestonePct,
          status: (t.status as any) || 'ACTIVE',
          alertDate: t.alertDate,
          whaleSolAmount: t.whaleSolAmount || undefined,
          dailyQuotaIndex: t.dailyQuotaIndex,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        });
      }
    }
  } catch {}

  return Array.from(trackedTokensMap.values())
    .filter((t) => t.status === 'ACTIVE')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 60);
}

/**
 * Updates prices, peaks, and milestones for a token
 */
export async function updateTokenPriceAndMilestones(
  tokenMint: string,
  updates: Partial<TrackedTokenRecord>
): Promise<void> {
  const existing = trackedTokensMap.get(tokenMint);
  if (!existing) return;

  Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
  await persistTokens();

  // Try Prisma (non-blocking)
  try {
    await prisma.earlyTrendingToken.update({
      where: { tokenMint },
      data: {
        peakPriceUsd: existing.peakPriceUsd,
        lowestPriceUsd: existing.lowestPriceUsd,
        lastAlertedPriceUsd: existing.lastAlertedPriceUsd,
        lastMilestonePct: existing.lastMilestonePct,
        lastDipMilestonePct: existing.lastDipMilestonePct,
        dexUrl: existing.dexUrl,
        pairAddress: existing.pairAddress,
      },
    });
  } catch {}
}

/**
 * Returns all tokens alerted for a specific date (YYYY-MM-DD)
 */
export async function getTokensForDate(dateStr: string): Promise<TrackedTokenRecord[]> {
  await hydrateTrackedTokens();

  // Try Prisma first
  try {
    const dbTokens = await prisma.earlyTrendingToken.findMany({
      where: { alertDate: dateStr },
      orderBy: { dailyQuotaIndex: 'asc' },
    });
    if (dbTokens && dbTokens.length > 0) {
      return dbTokens.map((t) => ({
        id: t.id,
        tokenMint: t.tokenMint,
        tokenSymbol: t.tokenSymbol,
        tokenName: t.tokenName,
        pairAddress: t.pairAddress || undefined,
        dexUrl: t.dexUrl || undefined,
        imageUrl: t.imageUrl,
        pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
        ageMinutes: t.ageMinutes || undefined,
        liquidityUsd: t.liquidityUsd || undefined,
        volume1h: t.volume1h || undefined,
        holderCount: t.holderCount || undefined,
        top20Pct: t.top20Pct || undefined,
        devHoldingPct: t.devHoldingPct || undefined,
        xUrl: t.xUrl || undefined,
        webUrl: t.webUrl || undefined,
        tgUrl: t.tgUrl || undefined,
        entryPriceUsd: t.entryPriceUsd,
        entryMarketCap: t.entryMarketCap,
        peakPriceUsd: t.peakPriceUsd,
        lowestPriceUsd: t.lowestPriceUsd,
        lastAlertedPriceUsd: t.lastAlertedPriceUsd,
        lastMilestonePct: t.lastMilestonePct,
        lastDipMilestonePct: t.lastDipMilestonePct,
        status: (t.status as any) || 'ACTIVE',
        alertDate: t.alertDate,
        whaleSolAmount: t.whaleSolAmount || undefined,
        dailyQuotaIndex: t.dailyQuotaIndex,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }));
    }
  } catch {}

  // Fallback to in-memory / Redis
  return Array.from(trackedTokensMap.values())
    .filter((t) => t.alertDate === dateStr)
    .sort((a, b) => a.dailyQuotaIndex - b.dailyQuotaIndex);
}

/**
 * Returns tokens for the past N days (for weekly recap)
 */
export async function getTokensForPastDays(days: number = 7): Promise<TrackedTokenRecord[]> {
  await hydrateTrackedTokens();
  const cutoff = Date.now() - days * 86400 * 1000;

  // Try Prisma first
  try {
    const dbTokens = await prisma.earlyTrendingToken.findMany({
      where: {
        createdAt: { gte: new Date(cutoff) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (dbTokens && dbTokens.length > 0) {
      return dbTokens.map((t) => ({
        id: t.id,
        tokenMint: t.tokenMint,
        tokenSymbol: t.tokenSymbol,
        tokenName: t.tokenName,
        pairAddress: t.pairAddress || undefined,
        dexUrl: t.dexUrl || undefined,
        imageUrl: t.imageUrl,
        pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
        ageMinutes: t.ageMinutes || undefined,
        liquidityUsd: t.liquidityUsd || undefined,
        volume1h: t.volume1h || undefined,
        holderCount: t.holderCount || undefined,
        top20Pct: t.top20Pct || undefined,
        devHoldingPct: t.devHoldingPct || undefined,
        xUrl: t.xUrl || undefined,
        webUrl: t.webUrl || undefined,
        tgUrl: t.tgUrl || undefined,
        entryPriceUsd: t.entryPriceUsd,
        entryMarketCap: t.entryMarketCap,
        peakPriceUsd: t.peakPriceUsd,
        lowestPriceUsd: t.lowestPriceUsd,
        lastAlertedPriceUsd: t.lastAlertedPriceUsd,
        lastMilestonePct: t.lastMilestonePct,
        lastDipMilestonePct: t.lastDipMilestonePct,
        status: (t.status as any) || 'ACTIVE',
        alertDate: t.alertDate,
        whaleSolAmount: t.whaleSolAmount || undefined,
        dailyQuotaIndex: t.dailyQuotaIndex,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }));
    }
  } catch {}

  // Fallback to in-memory / Redis
  return Array.from(trackedTokensMap.values())
    .filter((t) => new Date(t.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
