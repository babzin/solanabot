import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ADMIN_SECRET_KEY: z.string().min(8).default('super_secret_admin_key_solana_123'),

  DATABASE_URL: z.string().url().default('postgresql://postgres:password@localhost:5432/solana_copy_bot?schema=public'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  HELIUS_API_KEY: z.string().min(1).default('dummy_helius_api_key'),
  HELIUS_RPC_URL: z.string().url().optional(),
  HELIUS_WEBHOOK_ID: z.string().optional(),
  WEBHOOK_AUTH_TOKEN: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1).default('dummy_telegram_bot_token'),
  TELEGRAM_CHAT_ID: z.string().default('0'),
  TG_TOPIC_SAFE: z.coerce.number().default(0),
  TG_TOPIC_RISK: z.coerce.number().default(0),

  TROJAN_REF_CODE: z.string().default(''),
  PHOTON_REF_CODE: z.string().default(''),

  APP_BASE_URL: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().default('solearlytrending_bot'),

  USER_SOLANA_WALLET: z.string().default('6hb1Nmj9C8xZe5oWAKYBgJcPMZnqxAGTHPBqouuy5NmM'),
  SNIPER_PRIVATE_KEY: z.string().optional(),
  AUTO_SNIPE_DEFAULT_SOL: z.coerce.number().default(0.01),
  AUTO_SNIPE_ENABLED: z.coerce.boolean().default(false),
  TELEGRAM_ENABLE_POLLING: z.coerce.boolean().default(true),

  MAX_TRACKED_WALLETS: z.coerce.number().default(100),
  CACHE_TTL_SECONDS: z.coerce.number().default(600),
  PRICE_IMPACT_MAX_PERCENT: z.coerce.number().default(3.0),
  MIN_POOL_RESERVE_SOL: z.coerce.number().default(25.0),
  DISCOVERY_INTERVAL_HOURS: z.coerce.number().default(24),
  ENABLE_TUNNEL: z.coerce.boolean().default(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(parsed.error.format(), null, 2));
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

export const env = parsed.success ? parsed.data : envSchema.parse({});

if (env.NODE_ENV === 'production' && env.ADMIN_SECRET_KEY === 'super_secret_admin_key_solana_123') {
  console.warn('⚠️ WARNING: Using default ADMIN_SECRET_KEY in production! Please set a secure value in your .env');
}
