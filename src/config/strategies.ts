import { RiskTier, StrategyCriteria, StrategyProfile } from '../types/index.js';

export const KNOWN_PROGRAMS = {
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

export const STRATEGY_DEFINITIONS: Record<StrategyProfile, StrategyCriteria> = {
  // --- 4 SAFE PROFILES ---
  [StrategyProfile.MIGRATION_CONSOLIDATOR]: {
    name: 'Migration Consolidator',
    tier: RiskTier.SAFE,
    minWinRate: 0.60,
    minHoldingSeconds: 1800, // 30 mins
    maxHoldingSeconds: 14400, // 4 hours
    minEntryMarketCap: 150_000,
    maxEntryMarketCap: 500_000,
    targetTpPercent: 40,
    targetSlPercent: 15,
    strategyNotes: 'Trades post-Pump.fun migration pools consolidating on Raydium.',
  },
  [StrategyProfile.SWING_WHALE]: {
    name: 'High-Capacity Swing Whale',
    tier: RiskTier.SAFE,
    minWinRate: 0.58,
    minHoldingSeconds: 14400, // > 4 hours
    minSwapSol: 10,
    maxSwapSol: 50,
    targetTpPercent: 50,
    targetSlPercent: 15,
    strategyNotes: 'High-conviction, large-size swings on established liquidity pools.',
  },
  [StrategyProfile.DIP_ACCUMULATOR]: {
    name: 'Dip Accumulator',
    tier: RiskTier.SAFE,
    minWinRate: 0.65,
    minHoldingSeconds: 1800,
    targetTpPercent: 45,
    targetSlPercent: 15,
    strategyNotes: 'Buys high-volume tokens experiencing 30-50% pullbacks.',
  },
  [StrategyProfile.MULTI_DEX_SCALPER]: {
    name: 'Multi-DEX Scalper',
    tier: RiskTier.SAFE,
    minWinRate: 0.75,
    minHoldingSeconds: 300, // 5 mins
    maxHoldingSeconds: 1200, // 20 mins
    targetTpPercent: 25,
    targetSlPercent: 10,
    strategyNotes: 'Consistent high win-rate scalps with low drawdown.',
  },

  // --- 4 HIGH-RISK / DEGEN PROFILES ---
  [StrategyProfile.BONDING_BREAKOUT_HUNTER]: {
    name: 'Bonding Curve Breakout Hunter',
    tier: RiskTier.RISK,
    minWinRate: 0.45,
    minHoldingSeconds: 180, // > 3 mins (anti-MEV)
    maxHoldingSeconds: 3600,
    minEntryMarketCap: 30_000,
    maxEntryMarketCap: 65_000,
    targetTpPercent: 100, // 2x to pull initial
    targetSlPercent: 25,
    strategyNotes: 'Buys at 70%-90% Pump.fun curve graduation, targeting Raydium push.',
  },
  [StrategyProfile.DIAMOND_HAND_MOONBAGGER]: {
    name: 'Diamond-Hand Moonbagger',
    tier: RiskTier.RISK,
    minWinRate: 0.25, // Lower win rate compensated by 25x+ outlier wins
    minHoldingSeconds: 86400, // > 24 hours
    targetTpPercent: 500,
    targetSlPercent: 30,
    strategyNotes: 'Patiently holds asymmetric outlier runners targeting 20x-100x.',
  },
  [StrategyProfile.EARLY_SUPPLY_SNIFFER]: {
    name: 'Early Supply Sniffer',
    tier: RiskTier.RISK,
    minWinRate: 0.50,
    minHoldingSeconds: 180,
    maxSwapSol: 1.5,
    minEntryMarketCap: 12_000,
    maxEntryMarketCap: 40_000,
    targetTpPercent: 150,
    targetSlPercent: 25,
    strategyNotes: 'Small position sizes sniping early organic community traction.',
  },
  [StrategyProfile.META_TRACKER]: {
    name: 'Deployer & Meta Tracker',
    tier: RiskTier.RISK,
    minWinRate: 0.55,
    minHoldingSeconds: 600,
    targetTpPercent: 200,
    targetSlPercent: 20,
    strategyNotes: 'Identifies repeat winners surfing viral narrative meta trends.',
  },
};

const CALLSIGN_ADJECTIVES = [
  'Apex', 'Alpha', 'Ghost', 'Shadow', 'Neon', 'Viper', 'Iron', 'Titan',
  'Quantum', 'Hyper', 'Stealth', 'Cosmic', 'Solar', 'Velvet', 'Falcon',
  'Phoenix', 'Orbit', 'Phantom', 'Cobalt', 'Storm', 'Laser', 'Prime'
];

const CALLSIGN_NOUNS: Record<StrategyProfile, string[]> = {
  [StrategyProfile.MULTI_DEX_SCALPER]: ['Scalper', 'Razor', 'Sprint', 'Phantom'],
  [StrategyProfile.SWING_WHALE]: ['Whale', 'Leviathan', 'Titan', 'Colossus'],
  [StrategyProfile.MIGRATION_CONSOLIDATOR]: ['Pioneer', 'Navigator', 'Harvester', 'Vanguard'],
  [StrategyProfile.DIP_ACCUMULATOR]: ['Sniper', 'Accumulator', 'Vault', 'Sponge'],
  [StrategyProfile.BONDING_BREAKOUT_HUNTER]: ['Hunter', 'Moonshot', 'Breaker', 'Blaster'],
  [StrategyProfile.DIAMOND_HAND_MOONBAGGER]: ['Moonbagger', 'Hodler', 'Diamond', 'Cosmonaut'],
  [StrategyProfile.EARLY_SUPPLY_SNIFFER]: ['Sniffer', 'Hound', 'Scout', 'Tracker'],
  [StrategyProfile.META_TRACKER]: ['Oracle', 'Surfer', 'Trendsetter', 'Visionary'],
};

const CALLSIGN_ICONS: Record<StrategyProfile, string> = {
  [StrategyProfile.MULTI_DEX_SCALPER]: '⚡',
  [StrategyProfile.SWING_WHALE]: '🐋',
  [StrategyProfile.MIGRATION_CONSOLIDATOR]: '🦅',
  [StrategyProfile.DIP_ACCUMULATOR]: '💎',
  [StrategyProfile.BONDING_BREAKOUT_HUNTER]: '🚀',
  [StrategyProfile.DIAMOND_HAND_MOONBAGGER]: '🪐',
  [StrategyProfile.EARLY_SUPPLY_SNIFFER]: '🕵️',
  [StrategyProfile.META_TRACKER]: '🔮',
};

/**
 * Deterministically generates a memorable system callsign/nickname for a wallet.
 * e.g. "⚡ Apex Scalper #07" or "🐋 Titan Whale #12"
 */
export function generateWalletAlias(address: string, profile: StrategyProfile, indexNumber?: number): string {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  }

  const icon = CALLSIGN_ICONS[profile] || '🎯';
  const adjectives = CALLSIGN_ADJECTIVES;
  const nouns = CALLSIGN_NOUNS[profile] || ['Trader'];

  const adj = adjectives[hash % adjectives.length];
  const noun = nouns[(hash >>> 3) % nouns.length];

  // Number from 1 to 30 to help users identify the 30 tracked wallets
  const num = indexNumber !== undefined
    ? indexNumber
    : ((hash >>> 5) % 30) + 1;
  const numFormatted = num < 10 ? `0${num}` : `${num}`;

  return `${icon} ${adj} ${noun} #${numFormatted}`;
}

