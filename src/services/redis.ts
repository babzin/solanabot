import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { RiskTier, ScoredWallet } from '../types/index.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => {
  console.log('✅ Redis client connected successfully');
});

redis.on('error', (err: Error) => {
  console.error('⚠️ Redis error:', err.message);
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

/**
 * Checks if a transaction signature was already ingested/processed.
 * Sets key with 24-hour expiration if new.
 */
export async function isDuplicateSignature(signature: string): Promise<boolean> {
  const key = REDIS_KEYS.SIG_DEDUP(signature);
  const result = await redis.set(key, '1', 'EX', 86400, 'NX');
  // NX returns 'OK' if the key was set (meaning it's new), or null if it already existed
  return result === null;
}

/**
 * Syncs the active wallet sets and metadata into Redis
 */
export async function syncWalletsToRedis(wallets: ScoredWallet[]): Promise<void> {
  const pipeline = redis.pipeline();

  // Clear previous active sets
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

    // Save wallet metadata
    pipeline.set(
      REDIS_KEYS.WALLET_META(w.address),
      JSON.stringify(w),
      'EX',
      86400 * 7 // 7 days retention
    );
  }

  await pipeline.exec();
  console.log(`💾 Synced ${wallets.length} active wallets to Redis.`);
}

/**
 * Checks if an address is currently in the active tracked set
 */
export async function isWalletTracked(address: string): Promise<boolean> {
  const isMember = await redis.sismember(REDIS_KEYS.WALLETS_ALL, address);
  return isMember === 1;
}

/**
 * Gets cached wallet metadata
 */
export async function getWalletMetadata(address: string): Promise<ScoredWallet | null> {
  const data = await redis.get(REDIS_KEYS.WALLET_META(address));
  if (!data) return null;
  try {
    return JSON.parse(data) as ScoredWallet;
  } catch {
    return null;
  }
}

/**
 * Generic cached fetch helper with JSON serialization
 */
export async function getCached<T>(key: string): Promise<T | null> {
  if (redis.status !== 'ready') return null;
  try {
    const data = await redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function setCached<T>(key: string, data: T, ttlSeconds: number = env.CACHE_TTL_SECONDS): Promise<void> {
  if (redis.status !== 'ready') return;
  try {
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch {
    // Ignore cache set error if redis is offline
  }
}
