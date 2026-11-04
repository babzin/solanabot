import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { RiskTier, ScoredWallet } from '../types/index.js';

let redisLimitHit = false;

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  connectTimeout: 5000,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (redisLimitHit || times > 3) {
      return null; // Stop reconnecting after 3 attempts or on quota error
    }
    return Math.min(times * 100, 2000);
  },
});

// Try to connect gracefully without unhandled rejection
redis.connect().catch((err: Error) => {
  if (err.message.includes('Fixed plan limits') || err.message.includes('quota') || err.message.includes('limit')) {
    redisLimitHit = true;
    console.warn('⚠️ [Redis Notice] Upstash database quota reached. Switching seamlessly to in-memory/disk store.');
  } else {
    console.warn('⚠️ [Redis Connect Notice]:', err.message);
  }
});

redis.on('connect', () => {
  console.log('✅ Redis client connected successfully');
});

redis.on('error', (err: Error) => {
  if (err.message.includes('Fixed plan limits') || err.message.includes('quota') || err.message.includes('limit')) {
    if (!redisLimitHit) {
      redisLimitHit = true;
      console.warn('⚠️ [Redis Notice] Upstash quota limit hit. Seamlessly falling back to local memory and disk JSON.');
      try {
        redis.disconnect();
      } catch {}
    }
  } else {
    console.warn('⚠️ Redis notice:', err.message);
  }
});

// Keys
export const REDIS_KEYS = {
  WALLETS_ALL: 'wallets:active:all',
  WALLETS_SAFE: 'wallets:active:safe',
  WALLETS_RISK: 'wallets:active:risk',
  WALLET_META: (addr: string) => `wallet:meta:${addr}`,
  SIG_DEDUP: (sig: string) => `dedup:sig:${sig}`,
  TOKEN_CACHE: (mint: string) => `token:cache:${mint}`,
  SECURITY_CACHE: (mint: string) => `security:cache:${mint}`,
};

// Fast-path in-memory set for 0ms lookup across hundreds of accounts in swap transactions
const localTrackedSet = new Set<string>();
const inMemorySignatures = new Set<string>();

/**
 * Checks if a transaction signature was already ingested/processed.
 * Sets key with 24-hour expiration if new.
 */
export async function isDuplicateSignature(signature: string): Promise<boolean> {
  if (inMemorySignatures.has(signature)) return true;
  inMemorySignatures.add(signature);
  if (inMemorySignatures.size > 10000) {
    const first = inMemorySignatures.values().next().value;
    if (first) inMemorySignatures.delete(first);
  }

  if (redisLimitHit || redis.status !== 'ready') {
    return false;
  }

  try {
    const key = REDIS_KEYS.SIG_DEDUP(signature);
    const result = await redis.set(key, '1', 'EX', 86400, 'NX');
    return result === null;
  } catch {
    return false;
  }
}

/**
 * Syncs the active wallet sets and metadata into Redis
 */
export async function syncWalletsToRedis(wallets: ScoredWallet[]): Promise<void> {
  localTrackedSet.clear();
  for (const w of wallets) {
    localTrackedSet.add(w.address);
  }

  if (redisLimitHit || redis.status !== 'ready') return;

  try {
    const pipeline = redis.pipeline();

    pipeline.del(REDIS_KEYS.WALLETS_ALL);
    pipeline.del(REDIS_KEYS.WALLETS_SAFE);
    pipeline.del(REDIS_KEYS.WALLETS_RISK);

    for (const w of wallets) {
      pipeline.sadd(REDIS_KEYS.WALLETS_ALL, w.address);
      if (w.tier === RiskTier.SAFE) {
        pipeline.sadd(REDIS_KEYS.WALLETS_SAFE, w.address);
      } else {
        pipeline.sadd(REDIS_KEYS.WALLETS_RISK, w.address);
      }

      pipeline.set(
        REDIS_KEYS.WALLET_META(w.address),
        JSON.stringify(w),
        'EX',
        86400 * 7
      );
    }

    await pipeline.exec();
    console.log(`💾 Synced ${wallets.length} active wallets to Redis.`);
  } catch {}
}

/**
 * Checks if an address is currently in the active tracked set (0ms in-memory fast-path)
 */
export async function isWalletTracked(address: string): Promise<boolean> {
  if (localTrackedSet.size > 0) {
    return localTrackedSet.has(address);
  }
  if (redisLimitHit || redis.status !== 'ready') {
    return false;
  }
  try {
    const isMember = await redis.sismember(REDIS_KEYS.WALLETS_ALL, address);
    if (isMember === 1) {
      localTrackedSet.add(address);
      return true;
    }
  } catch {}
  return false;
}

export function getLocalTrackedAddresses(): string[] {
  return Array.from(localTrackedSet);
}

/**
 * Gets cached wallet metadata
 */
export async function getWalletMetadata(address: string): Promise<ScoredWallet | null> {
  if (redisLimitHit || redis.status !== 'ready') return null;
  try {
    const data = await redis.get(REDIS_KEYS.WALLET_META(address));
    if (!data) return null;
    return JSON.parse(data) as ScoredWallet;
  } catch {
    return null;
  }
}

/**
 * Generic cached fetch helper with JSON serialization
 */
export async function getCached<T>(key: string): Promise<T | null> {
  if (redisLimitHit || redis.status !== 'ready') return null;
  try {
    const data = await redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export async function setCached<T>(key: string, data: T, ttlSeconds: number = env.CACHE_TTL_SECONDS): Promise<void> {
  if (redisLimitHit || redis.status !== 'ready') return;
  try {
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch {
    // Ignore cache set error if redis is offline or over quota
  }
}
