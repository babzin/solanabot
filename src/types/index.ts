export enum RiskTier {
  SAFE = 'SAFE',
  RISK = 'RISK',
}

export enum StrategyProfile {
  // Safe Profiles
  MIGRATION_CONSOLIDATOR = 'MIGRATION_CONSOLIDATOR',
  SWING_WHALE = 'SWING_WHALE',
  DIP_ACCUMULATOR = 'DIP_ACCUMULATOR',
  MULTI_DEX_SCALPER = 'MULTI_DEX_SCALPER',

  // High-Risk Profiles
  BONDING_BREAKOUT_HUNTER = 'BONDING_BREAKOUT_HUNTER',
  DIAMOND_HAND_MOONBAGGER = 'DIAMOND_HAND_MOONBAGGER',
  EARLY_SUPPLY_SNIFFER = 'EARLY_SUPPLY_SNIFFER',
  META_TRACKER = 'META_TRACKER',
}

export interface StrategyCriteria {
  name: string;
  tier: RiskTier;
  minWinRate: number;
  minHoldingSeconds: number;
  maxHoldingSeconds?: number;
  minEntryMarketCap?: number;
  maxEntryMarketCap?: number;
  minSwapSol?: number;
  maxSwapSol?: number;
  targetTpPercent: number;
  targetSlPercent: number;
  strategyNotes: string;
}

export interface DiscoveredBuy {
  signature: string;
  tokenMint: string;
  tokenSymbol?: string;
  tokenAmount: number;
  solAmount: number;
  timestamp: number;
}

export interface ScoredWallet {
  address: string;
  label?: string;
  tier: RiskTier;
  strategyProfile: StrategyProfile;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  medianHoldSeconds: number;
  netSolProfit: number;
  recentBuys?: DiscoveredBuy[];
}

export interface SwapEvent {
  signature: string;
  walletAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  side: 'BUY' | 'SELL';
  solAmount: number;
  tokenAmount: number;
  soldPercent?: number;
  programId: string;
  timestamp: number;
}

export interface SecurityCheckResult {
  passed: boolean;
  isPumpFun: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  score?: number;
  reasons: string[];
  analytics?: Partial<TokenAnalytics>;
}

export interface HolderDistributionItem {
  address: string;
  pct: number;
  type: 'dev' | 'bundle' | 'whale' | 'fish' | 'shrimp';
}

export interface TokenAnalytics {
  ageText: string;
  securityStatus: 'SAFE' | 'WARNING' | 'DANGER';
  securityIcon: string;
  twitterUrl?: string;
  telegramUrl?: string;
  chartUrl: string;
  peakMarketCap: number;
  volume1h: number;
  fakeVolume: number;
  holderCount: number;
  bundleCount: number;
  bundleInitialPct: number;
  bundleCurrentPct: number;
  sniperCount: number;
  sniperInitialPct: number;
  sniperCurrentPct: number;
  top20HoldPct: number;
  topHoldersDistribution: HolderDistributionItem[];
  devAddress?: string;
  devSolBalance: number;
  devHoldingPct: number;
  devSoldPct: number;
  devBundledPct: number;
  airdropPct: number;
  lpBurntPct: number;
}

export interface MarketData {
  tokenName?: string;
  tokenSymbol?: string;
  priceUsd: number;
  priceNative: number;
  marketCap: number;
  liquiditySol: number;
  liquidityUsd: number;
  poolReserveSol: number;
  priceImpactPercent: number;
  dexUrl: string;
  pairAddress?: string;
  isBondingCurve: boolean;
  curveProgress?: number;
  analytics?: TokenAnalytics;
}

export interface TradeAlert {
  signature: string;
  wallet: ScoredWallet;
  swap: SwapEvent;
  market: MarketData;
  security: SecurityCheckResult;
  timestamp: number;
}

// Helius Enhanced Webhook Payload Types
export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
  mint: string;
  tokenStandard?: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface HeliusAccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: Array<{
    userAccount: string;
    tokenAccount: string;
    rawTokenAmount: {
      tokenAmount: string;
      decimals: number;
    };
    mint: string;
  }>;
}

export interface HeliusParsedTransaction {
  description: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  accountData?: HeliusAccountData[];
  instructions?: Array<{
    programId: string;
    innerInstructions?: Array<{
      programId: string;
    }>;
  }>;
  events?: {
    swap?: {
      nativeInput?: { amount: string; userAccount: string };
      nativeOutput?: { amount: string; userAccount: string };
      tokenInputs?: Array<{ mint: string; rawTokenAmount: { tokenAmount: string; decimals: number }; userAccount: string }>;
      tokenOutputs?: Array<{ mint: string; rawTokenAmount: { tokenAmount: string; decimals: number }; userAccount: string }>;
    };
  };
}

export interface AiNarrativeScore {
  convictionScore: number; // 0 to 100
  metaCategory: string; // e.g. "AI Agent", "Cat / Animal Meta", "Cult Meme", "Utility / Infra", "Generic Copycat"
  rugRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  thesis: string; // 1-2 sentence crisp takeaway
  signals: {
    memeVirality: number; // 0-100
    socialLegitimacy: number; // 0-100
    devSafety: number; // 0-100
  };
  providerUsed: 'gemini' | 'groq' | 'heuristic-slm';
}

export interface AiAuditResult {
  mint: string;
  symbol: string;
  name: string;
  score: AiNarrativeScore;
  onChainMetrics: {
    marketCapUsd: number;
    priceUsd: number;
    ageMinutes: number;
    liquidityUsd: number;
    snipersCount: number;
    devHoldingPct: number;
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    liquidityBurntPct: number;
  };
  recommendation: 'STRONG_BUY' | 'SPECULATIVE_SNIPE' | 'WAIT_AND_WATCH' | 'AVOID_RUG';
  summary: string;
}

