import { env } from '../src/config/env.js';
import { prisma } from '../src/services/db.js';
import {
  getUserPreferences,
  setUserFilterMode,
} from '../src/services/sniper.js';
import { buildUnifiedAlertCard } from '../src/services/telegram.js';
import { RiskTier, StrategyProfile, TradeAlert } from '../src/types/index.js';

async function testFilterAndRoster() {
  console.log('🧪 Starting Filter Mode & Named Wallets Verification Test...\n');

  const testChatId = env.TELEGRAM_CHAT_ID || '8129176485';

  // 1. Test Filter Switching
  console.log('1️⃣ Testing Filter Mode Updates:');
  const safeMode = await setUserFilterMode(testChatId, 'SAFE');
  console.log(`   Set SAFE -> filterMode: ${safeMode.filterMode}, receiveSafe: ${safeMode.receiveSafeAlerts}, receiveRisk: ${safeMode.receiveRiskAlerts}`);
  if (safeMode.filterMode !== 'SAFE' || !safeMode.receiveSafeAlerts || safeMode.receiveRiskAlerts) {
    throw new Error('SAFE filter mode failed!');
  }

  const riskMode = await setUserFilterMode(testChatId, 'RISK');
  console.log(`   Set RISK -> filterMode: ${riskMode.filterMode}, receiveSafe: ${riskMode.receiveSafeAlerts}, receiveRisk: ${riskMode.receiveRiskAlerts}`);
  if (riskMode.filterMode !== 'RISK' || riskMode.receiveSafeAlerts || !riskMode.receiveRiskAlerts) {
    throw new Error('RISK filter mode failed!');
  }

  const allMode = await setUserFilterMode(testChatId, 'ALL');
  console.log(`   Set ALL  -> filterMode: ${allMode.filterMode}, receiveSafe: ${allMode.receiveSafeAlerts}, receiveRisk: ${allMode.receiveRiskAlerts}`);
  if (allMode.filterMode !== 'ALL' || !allMode.receiveSafeAlerts || !allMode.receiveRiskAlerts) {
    throw new Error('ALL filter mode failed!');
  }
  console.log('   ✅ All 3 Filter Modes (Safe, Risk, All) verified working with DB/Cache!\n');

  // 2. Test Wallet Roster and Names
  console.log('2️⃣ Verifying Tracked Wallets & Custom Names:');
  const wallets = await prisma.trackedWallet.findMany({
    where: { isActive: true },
    orderBy: { winRate: 'desc' },
  });
  console.log(`   Found ${wallets.length} active smart-money wallets in DB.`);
  const safeCount = wallets.filter((w) => w.tier === 'SAFE').length;
  const riskCount = wallets.filter((w) => w.tier === 'RISK').length;
  console.log(`   Roster Composition: ${safeCount} SAFE Wallets | ${riskCount} RISK Wallets`);

  console.log('\n   Sample Named Wallets:');
  wallets.slice(0, 4).forEach((w) => {
    console.log(`   • [${w.tier}] "${w.label}" (${w.address.slice(0, 4)}...${w.address.slice(-4)}) - ${(w.winRate * 100).toFixed(0)}% WR | ${w.profitFactor}x PF`);
  });

  // 3. Test Alert Formatting in "Show All" Mode
  console.log('\n3️⃣ Verifying Alert Badging in "Show All" Mode:');
  const sampleSafeAlert: TradeAlert = {
    signature: '5xTestSigSafe11111111111111111111111111111111111111111111111111111111111111111',
    wallet: {
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      label: '⚡ Cobalt Sprint #01',
      tier: RiskTier.SAFE,
      strategyProfile: StrategyProfile.MULTI_DEX_SCALPER,
      winRate: 0.84,
      profitFactor: 4.12,
      totalTrades: 42,
      medianHoldSeconds: 420,
      netSolProfit: 34.8,
    },
    swap: {
      signature: '5xTestSigSafe11111111111111111111111111111111111111111111111111111111111111111',
      walletAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      tokenMint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
      tokenSymbol: 'GOAT',
      side: 'BUY',
      solAmount: 2.5,
      tokenAmount: 25000,
      programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      timestamp: Math.floor(Date.now() / 1000),
    },
    market: {
      tokenMint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
      tokenSymbol: 'GOAT',
      tokenName: 'Goatseus Maximus',
      priceUsd: 0.016,
      marketCap: 1600000,
      liquidityUsd: 250000,
      poolReserveSol: 450,
      priceImpactPercent: 0.4,
      isBondingCurve: false,
    },
    security: {
      passed: true,
      reasons: [],
    },
    timestamp: Date.now(),
  };

  const safeCard = buildUnifiedAlertCard(sampleSafeAlert);
  console.log('   --- SAFE ALERT PREVIEW ---');
  console.log(safeCard.slice(0, 300) + '...\n');
  if (!safeCard.includes('[SAFE TIER SIGNAL]') || !safeCard.includes('⚡ Cobalt Sprint #01')) {
    throw new Error('Safe alert missing tier badge or callsign name!');
  }

  const sampleRiskAlert: TradeAlert = {
    ...sampleSafeAlert,
    wallet: {
      address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      label: '🚀 Velvet Moonshot #01',
      tier: RiskTier.RISK,
      strategyProfile: StrategyProfile.BONDING_BREAKOUT_HUNTER,
      winRate: 0.62,
      profitFactor: 5.4,
      totalTrades: 68,
      medianHoldSeconds: 340,
      netSolProfit: 82.3,
    },
  };

  const riskCard = buildUnifiedAlertCard(sampleRiskAlert);
  console.log('   --- RISK ALERT PREVIEW ---');
  console.log(riskCard.slice(0, 300) + '...\n');
  if (!riskCard.includes('[HIGH-RISK / MOONBAG SIGNAL]') || !riskCard.includes('🚀 Velvet Moonshot #01')) {
    throw new Error('Risk alert missing tier badge or callsign name!');
  }

  console.log('🎉 ALL VERIFICATION CHECKS PASSED PERFECTLY!');
}

testFilterAndRoster()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ Verification failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
