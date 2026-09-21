import { dispatchEarlyTrendingAlert, dispatchPricePumpMilestoneAlert, getDexScreenerUrl } from '../src/services/telegram.js';

async function testAlertFormat() {
  console.log('🧪 Testing @solearlytrending alert card and milestone notifications...\n');

  const mockCandidate = {
    tokenMint: '9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump',
    pairAddress: '7Rnw9QqtF2HFM6tKAegLpe96n56jMctkotBTKSHXWBEq',
    dexUrl: 'https://dexscreener.com/solana/7rnw9qqtf2hfm6tkaeglpe96n56jmctkotbtkshxwbeq',
    tokenName: 'musebook.trade',
    tokenSymbol: 'musebook',
    priceUsd: 0.0000562,
    marketCap: 56200,
    target5xMarketCap: 281000,
    target20xMarketCap: 1124000,
    liquidityUsd: 18800,
    poolReserveSol: 22.0,
    volume1h: 15400,
    volume24h: 32000,
    ageText: '2m',
    whaleSolAmount: 5.2,
    whaleConvictionReason: '⚡ 5-Minute Volume Spike ($3,200 in 5m)',
    narrativeTag: '🔥 Viral Meme / Community Cult',
    securityPassed: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    potentialScore: 84.5,
    holderCount: 393,
    top20Pct: 30,
    devHoldingPct: 0,
    xUrl: 'https://x.com/musebook',
    tgUrl: 'https://t.me/musebook',
  };

  console.log('1️⃣ Verified DexScreener Canonical URL:');
  console.log(getDexScreenerUrl(mockCandidate));

  console.log('\n2️⃣ Testing dispatchEarlyTrendingAlert (Dry Run):');
  await dispatchEarlyTrendingAlert(mockCandidate, 1);

  console.log('\n3️⃣ Testing dispatchPricePumpMilestoneAlert at +50% (Dry Run):');
  await dispatchPricePumpMilestoneAlert({
    tokenMint: mockCandidate.tokenMint,
    tokenSymbol: mockCandidate.tokenSymbol,
    tokenName: mockCandidate.tokenName,
    entryPriceUsd: 0.0000562,
    currentPriceUsd: 0.0000843,
    entryMarketCap: 56200,
    currentMarketCap: 84300,
    gainPercent: 50.0,
    milestonePercent: 50,
    multiplier: 1.5,
    elapsedTimeText: '8m',
    dexUrl: mockCandidate.dexUrl,
  });

  console.log('\n4️⃣ Testing dispatchPricePumpMilestoneAlert at 2X (Dry Run):');
  await dispatchPricePumpMilestoneAlert({
    tokenMint: mockCandidate.tokenMint,
    tokenSymbol: mockCandidate.tokenSymbol,
    tokenName: mockCandidate.tokenName,
    entryPriceUsd: 0.0000562,
    currentPriceUsd: 0.0001124,
    entryMarketCap: 56200,
    currentMarketCap: 112400,
    gainPercent: 100.0,
    milestonePercent: 100,
    multiplier: 2.0,
    elapsedTimeText: '15m',
    dexUrl: mockCandidate.dexUrl,
  });

  console.log('\n✅ All tests passed!');
  process.exit(0);
}

testAlertFormat().catch((err) => {
  console.error(err);
  process.exit(1);
});
