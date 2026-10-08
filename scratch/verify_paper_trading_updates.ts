import { processPaperTradeBuy, getPaperPortfolioSummary } from '../src/services/paperTrading.js';

async function runTests() {
  console.log('🧪 Starting Paper Trading & Reset Updates Verification...');

  // Test 1: Coin with SLM NO_GO signal MUST trade instantly with paper money
  console.log('\n--- Test 1: Coin with SLM NO_GO ---');
  const dummyNoGoMint = 'NoGoTestMint' + Date.now().toString().slice(-6);
  const pos = await processPaperTradeBuy({
    tokenMint: dummyNoGoMint,
    tokenSymbol: 'TESTNOGO',
    tokenName: 'Test No Go Token',
    priceUsd: 0.00045,
    marketCap: 45000,
    liquidityUsd: 15000,
    slmVerdict: {
      viabilitySignal: 'NO_GO',
      organicHypeScore: 2,
      narrativeStrength: 3,
      volumeVelocityAlignment: 2,
      recommendedMultiples: [2, 4],
      trailingStopLossPct: 15,
      riskFlags: ['High dev dump signature', 'Bot-shilled raid detected'],
      justificationSummary: 'Suspected coordinated raid with low organic interaction.',
      telegramAnalyzed: true,
      twitterAnalyzed: false,
    },
  });

  if (!pos) {
    console.error('❌ FAILED: processPaperTradeBuy returned null for SLM NO_GO candidate!');
    process.exit(1);
  } else {
    console.log(`✅ PASSED: Paper buy executed for $${pos.tokenSymbol} despite NO_GO signal!`);
    console.log(`   Position ID: ${pos.id}, Invested: $${pos.investedUsd.toFixed(2)}, SLM: ${pos.slmVerdict?.viabilitySignal}`);
  }

  // Test 2: User submission with forceBuy
  console.log('\n--- Test 2: User Submitted Coin with forceBuy ---');
  const dummyUserMint = 'UserSubMint' + Date.now().toString().slice(-6);
  const userPos = await processPaperTradeBuy(
    {
      tokenMint: dummyUserMint,
      tokenSymbol: 'USERSUB',
      tokenName: 'User Submitted Coin',
      priceUsd: 0.0012,
      marketCap: 120000,
      liquidityUsd: 25000,
      forceBuy: true,
      slmVerdict: {
        viabilitySignal: 'NO_GO',
        organicHypeScore: 1,
        narrativeStrength: 1,
        volumeVelocityAlignment: 1,
        recommendedMultiples: [2],
        trailingStopLossPct: 20,
        riskFlags: ['Synthetic pump detected'],
        justificationSummary: 'Flagged by SLM but traded with paper money on user submission.',
        telegramAnalyzed: false,
        twitterAnalyzed: false,
      },
    },
    { forceBuy: true }
  );

  if (!userPos) {
    console.error('❌ FAILED: User submission forceBuy returned null!');
    process.exit(1);
  } else {
    console.log(`✅ PASSED: User submitted trade executed instantly for $${userPos.tokenSymbol}!`);
    console.log(`   Tokens: ${userPos.tokensAcquired.toFixed(2)}, Status: ${userPos.status}`);
  }

  // Test 3: Verify Portfolio Summary
  console.log('\n--- Test 3: Portfolio Summary State ---');
  const summary = await getPaperPortfolioSummary();
  console.log(`✅ Net Equity: $${summary.netWorthUsd.toFixed(2)}, Active Positions: ${summary.activePositions.length}`);

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
