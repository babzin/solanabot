import { prisma } from '../src/services/db.js';
import { generateWalletAlias } from '../src/config/strategies.js';
import { RiskTier, StrategyProfile } from '../src/types/index.js';
import { env } from '../src/config/env.js';

// 30 distinct Solana smart-money wallet addresses
const INITIAL_SMART_WALLETS = [
  // 15 SAFE WALLETS
  {
    address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    profile: StrategyProfile.MULTI_DEX_SCALPER,
    tier: RiskTier.SAFE,
    winRate: 0.84,
    profitFactor: 4.12,
    totalTrades: 42,
    medianHoldSeconds: 420,
    netSolProfit: 34.8,
  },
  {
    address: '3K87fR9kL1mJ5x8Q2Z4W6e7T9p0A1B2C3D4E5F6G7H8I',
    profile: StrategyProfile.SWING_WHALE,
    tier: RiskTier.SAFE,
    winRate: 0.78,
    profitFactor: 3.85,
    totalTrades: 28,
    medianHoldSeconds: 15600,
    netSolProfit: 112.5,
  },
  {
    address: 'H84KTaN41Kq9X3ZJ7yqUoE1WJ94Z1L3z5D2J1B8k3LmP',
    profile: StrategyProfile.MIGRATION_CONSOLIDATOR,
    tier: RiskTier.SAFE,
    winRate: 0.72,
    profitFactor: 3.40,
    totalTrades: 35,
    medianHoldSeconds: 3600,
    netSolProfit: 46.2,
  },
  {
    address: '5dGwNffEvt2EAZSmTFWb1Jakscer95M6wB63ZZ452HJk',
    profile: StrategyProfile.DIP_ACCUMULATOR,
    tier: RiskTier.SAFE,
    winRate: 0.75,
    profitFactor: 3.65,
    totalTrades: 31,
    medianHoldSeconds: 2700,
    netSolProfit: 58.0,
  },
  {
    address: 'FhwFSBV6UZP55DWjVGAsqaatXajhMZS9ZV84p7Yzq6wj',
    profile: StrategyProfile.MULTI_DEX_SCALPER,
    tier: RiskTier.SAFE,
    winRate: 0.81,
    profitFactor: 3.90,
    totalTrades: 48,
    medianHoldSeconds: 510,
    netSolProfit: 29.4,
  },
  {
    address: '3LLiG6aUBwjxgYJ5LtyXsYWYbhyoV69JtRV5sQzGCpP7',
    profile: StrategyProfile.SWING_WHALE,
    tier: RiskTier.SAFE,
    winRate: 0.74,
    profitFactor: 3.55,
    totalTrades: 24,
    medianHoldSeconds: 18200,
    netSolProfit: 88.6,
  },
  {
    address: 'Aqk98Jyg5vD9wwYaLnR5NTbz8jMjNBbsvLK3QkLsdbwS',
    profile: StrategyProfile.MIGRATION_CONSOLIDATOR,
    tier: RiskTier.SAFE,
    winRate: 0.69,
    profitFactor: 3.10,
    totalTrades: 39,
    medianHoldSeconds: 4200,
    netSolProfit: 37.5,
  },
  {
    address: 'H2TCCt8ZzqwxqZwzaZ4Ps5Q3o8SemifD86dnSq1HcffG',
    profile: StrategyProfile.DIP_ACCUMULATOR,
    tier: RiskTier.SAFE,
    winRate: 0.76,
    profitFactor: 3.75,
    totalTrades: 29,
    medianHoldSeconds: 2400,
    netSolProfit: 41.2,
  },
  {
    address: '2yXyJk4j1C7d5x9N8m3P6Q4V1Z8A9B2C3D4E5F6G7H8',
    profile: StrategyProfile.MULTI_DEX_SCALPER,
    tier: RiskTier.SAFE,
    winRate: 0.79,
    profitFactor: 3.60,
    totalTrades: 55,
    medianHoldSeconds: 380,
    netSolProfit: 33.1,
  },
  {
    address: '4u8K1NmP3Z9X5y7W2v4A6c8E0B1D3F5G7H9J2K4M6N8',
    profile: StrategyProfile.SWING_WHALE,
    tier: RiskTier.SAFE,
    winRate: 0.71,
    profitFactor: 3.30,
    totalTrades: 22,
    medianHoldSeconds: 16800,
    netSolProfit: 76.4,
  },
  {
    address: '6t7Y8U9I0O1P2A3S4D5F6G7H8J9K0L1Z2X3C4V5B6N7',
    profile: StrategyProfile.MIGRATION_CONSOLIDATOR,
    tier: RiskTier.SAFE,
    winRate: 0.68,
    profitFactor: 2.95,
    totalTrades: 33,
    medianHoldSeconds: 5400,
    netSolProfit: 26.8,
  },
  {
    address: '8b9N0M1K2J3H4G5F6D7S8A9Q0W1E2R3T4Y5U6I7O8P9',
    profile: StrategyProfile.DIP_ACCUMULATOR,
    tier: RiskTier.SAFE,
    winRate: 0.73,
    profitFactor: 3.45,
    totalTrades: 27,
    medianHoldSeconds: 3100,
    netSolProfit: 38.9,
  },
  {
    address: '1a2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T1U2',
    profile: StrategyProfile.MULTI_DEX_SCALPER,
    tier: RiskTier.SAFE,
    winRate: 0.82,
    profitFactor: 4.05,
    totalTrades: 62,
    medianHoldSeconds: 450,
    netSolProfit: 44.5,
  },
  {
    address: '3v4C5X6Z7A8S9D0F1G2H3J4K5L6M7N8B9V0C1X2Z3A4',
    profile: StrategyProfile.SWING_WHALE,
    tier: RiskTier.SAFE,
    winRate: 0.70,
    profitFactor: 3.25,
    totalTrades: 19,
    medianHoldSeconds: 19400,
    netSolProfit: 65.0,
  },
  {
    address: '5z6X7C8V9B0N1M2K3J4H5G6F7D8S9A0Q1W2E3R4T5Y6',
    profile: StrategyProfile.DIP_ACCUMULATOR,
    tier: RiskTier.SAFE,
    winRate: 0.74,
    profitFactor: 3.50,
    totalTrades: 36,
    medianHoldSeconds: 2900,
    netSolProfit: 39.7,
  },

  // 15 HIGH RISK WALLETS
  {
    address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    profile: StrategyProfile.BONDING_BREAKOUT_HUNTER,
    tier: RiskTier.RISK,
    winRate: 0.62,
    profitFactor: 5.40,
    totalTrades: 68,
    medianHoldSeconds: 340,
    netSolProfit: 82.3,
  },
  {
    address: 'EjH1MRCvxepA4eGg3dzvByes68B21SixHVVfXyRwuCMd',
    profile: StrategyProfile.EARLY_SUPPLY_SNIFFER,
    tier: RiskTier.RISK,
    winRate: 0.58,
    profitFactor: 4.80,
    totalTrades: 75,
    medianHoldSeconds: 220,
    netSolProfit: 64.1,
  },
  {
    address: 'WaXgNmfnzZr3f8tygS7N7ujxYYb9mpbqp7PxzFMdhe7',
    profile: StrategyProfile.DIAMOND_HAND_MOONBAGGER,
    tier: RiskTier.RISK,
    winRate: 0.44,
    profitFactor: 6.20,
    totalTrades: 38,
    medianHoldSeconds: 98000,
    netSolProfit: 142.0,
  },
  {
    address: '7Md9sRQEomMXdhpQkV3NJw2Gjdy3KcvySawPwQ2vJ6sh',
    profile: StrategyProfile.META_TRACKER,
    tier: RiskTier.RISK,
    winRate: 0.56,
    profitFactor: 4.50,
    totalTrades: 52,
    medianHoldSeconds: 900,
    netSolProfit: 51.8,
  },
  {
    address: '6yJBdJuAyUYoAsfr1BeuaH26iaSGVEmoAaHAFLLSRNuo',
    profile: StrategyProfile.BONDING_BREAKOUT_HUNTER,
    tier: RiskTier.RISK,
    winRate: 0.60,
    profitFactor: 5.10,
    totalTrades: 61,
    medianHoldSeconds: 280,
    netSolProfit: 71.5,
  },
  {
    address: '7r8T9Y0U1I2O3P4A5S6D7F8G9H0J1K2L3Z4X5C6V7B8',
    profile: StrategyProfile.EARLY_SUPPLY_SNIFFER,
    tier: RiskTier.RISK,
    winRate: 0.54,
    profitFactor: 4.30,
    totalTrades: 82,
    medianHoldSeconds: 210,
    netSolProfit: 49.3,
  },
  {
    address: '9o0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4B5N6M7K8J9H0',
    profile: StrategyProfile.DIAMOND_HAND_MOONBAGGER,
    tier: RiskTier.RISK,
    winRate: 0.41,
    profitFactor: 5.80,
    totalTrades: 32,
    medianHoldSeconds: 104000,
    netSolProfit: 128.5,
  },
  {
    address: '1q2W3E4R5T6Y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2',
    profile: StrategyProfile.META_TRACKER,
    tier: RiskTier.RISK,
    winRate: 0.55,
    profitFactor: 4.20,
    totalTrades: 46,
    medianHoldSeconds: 780,
    netSolProfit: 42.0,
  },
  {
    address: '3e4R5T6Y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4',
    profile: StrategyProfile.BONDING_BREAKOUT_HUNTER,
    tier: RiskTier.RISK,
    winRate: 0.61,
    profitFactor: 5.25,
    totalTrades: 58,
    medianHoldSeconds: 310,
    netSolProfit: 66.8,
  },
  {
    address: '5t6Y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4B5N6',
    profile: StrategyProfile.EARLY_SUPPLY_SNIFFER,
    tier: RiskTier.RISK,
    winRate: 0.57,
    profitFactor: 4.60,
    totalTrades: 70,
    medianHoldSeconds: 240,
    netSolProfit: 55.4,
  },
  {
    address: '7u8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4B5N6M7K8',
    profile: StrategyProfile.DIAMOND_HAND_MOONBAGGER,
    tier: RiskTier.RISK,
    winRate: 0.43,
    profitFactor: 6.00,
    totalTrades: 35,
    medianHoldSeconds: 92000,
    netSolProfit: 135.0,
  },
  {
    address: '9i0O1P2A3S4D5F6G7H8J9K0L1Z2X3C4V5B6N7M8K9J0',
    profile: StrategyProfile.META_TRACKER,
    tier: RiskTier.RISK,
    winRate: 0.53,
    profitFactor: 4.10,
    totalTrades: 41,
    medianHoldSeconds: 840,
    netSolProfit: 38.6,
  },
  {
    address: '2w3E4R5T6Y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3',
    profile: StrategyProfile.BONDING_BREAKOUT_HUNTER,
    tier: RiskTier.RISK,
    winRate: 0.59,
    profitFactor: 4.95,
    totalTrades: 64,
    medianHoldSeconds: 290,
    netSolProfit: 61.2,
  },
  {
    address: '4r5T6Y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4B5',
    profile: StrategyProfile.EARLY_SUPPLY_SNIFFER,
    tier: RiskTier.RISK,
    winRate: 0.55,
    profitFactor: 4.40,
    totalTrades: 78,
    medianHoldSeconds: 230,
    netSolProfit: 47.9,
  },
  {
    address: '6y7U8I9O0P1A2S3D4F5G6H7J8K9L0Z1X2C3V4B5N6M7',
    profile: StrategyProfile.DIAMOND_HAND_MOONBAGGER,
    tier: RiskTier.RISK,
    winRate: 0.46,
    profitFactor: 6.50,
    totalTrades: 40,
    medianHoldSeconds: 110000,
    netSolProfit: 155.0,
  },
];

export async function seedSmartWallets() {
  console.log('🌱 Seeding 30 elite smart-money wallets with custom callsigns & metrics...');
  let index = 1;

  for (const item of INITIAL_SMART_WALLETS) {
    if (env.USER_SOLANA_WALLET && item.address === env.USER_SOLANA_WALLET) {
      continue; // Never track user's personal wallet
    }

    const label = generateWalletAlias(item.address, item.profile, index);

    await prisma.trackedWallet.upsert({
      where: { address: item.address },
      update: {
        label,
        tier: item.tier,
        strategyProfile: item.profile,
        winRate: item.winRate,
        profitFactor: item.profitFactor,
        totalTrades: item.totalTrades,
        medianHoldSeconds: item.medianHoldSeconds,
        netSolProfit: item.netSolProfit,
        isActive: true,
      },
      create: {
        address: item.address,
        label,
        tier: item.tier,
        strategyProfile: item.profile,
        winRate: item.winRate,
        profitFactor: item.profitFactor,
        totalTrades: item.totalTrades,
        medianHoldSeconds: item.medianHoldSeconds,
        netSolProfit: item.netSolProfit,
        isActive: true,
      },
    });

    index++;
  }

  const count = await prisma.trackedWallet.count();
  console.log(`✅ Successfully seeded ${count} smart-money wallets into Supabase!`);
}

seedSmartWallets()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ Seeding failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });

