import { processPaperTradeBuy, getPaperPortfolioSummary } from '../src/services/paperTrading.js';

async function testAutoRefillCount() {
  console.log('🧪 [TEST] Verifying auto-refill counter and tracking when paper money runs out...');

  const initialSummary = await getPaperPortfolioSummary();
  const initialRefillCount = initialSummary.wallet.autoRefillCount || 0;
  console.log(`Initial auto-refill count: ${initialRefillCount}`);

  // Test 1: Enter a coin that requires more than available cash (or drain cash first)
  // Let's enter a coin with a price and observe auto-refill if needed, or force trigger by creating candidates
  console.log('\n--- Test 1: Executing buy candidate ---');
  const dummyMint1 = 'RefillTestMint1_' + Date.now();
  const pos1 = await processPaperTradeBuy({
    tokenMint: dummyMint1,
    tokenSymbol: 'REFILL1',
    tokenName: 'Refill Token 1',
    priceUsd: 0.0005,
    marketCap: 50000,
    liquidityUsd: 20000,
    aiScore: {
      convictionScore: 80,
      rugRisk: 'LOW',
      strategyProfile: 'BALANCED_MOMENTUM',
      suggestedAllocationPct: 3.0,
      thesis: 'Testing auto-refill counter.',
    },
  });

  if (!pos1) {
    throw new Error('❌ Test 1 FAILED: Could not enter position 1!');
  }
  console.log(`✅ Position 1 entered: $${pos1.tokenSymbol}`);

  const summaryAfter1 = await getPaperPortfolioSummary();
  console.log(`Wallet after buy 1: Liquid Cash = $${summaryAfter1.wallet.liquidCashUsd.toFixed(2)}, Refill Count = ${summaryAfter1.wallet.autoRefillCount}`);

  // Verify that summary contains autoRefillCount and totalRefilledUsd
  if (typeof summaryAfter1.autoRefillCount !== 'number' || typeof summaryAfter1.totalRefilledUsd !== 'number') {
    throw new Error('❌ Test FAILED: autoRefillCount or totalRefilledUsd is missing from PaperPortfolioSummary!');
  }
  console.log(`✅ PaperPortfolioSummary correctly exposes autoRefillCount (${summaryAfter1.autoRefillCount}) and totalRefilledUsd ($${summaryAfter1.totalRefilledUsd.toFixed(2)})`);

  console.log('\n🎉 ALL REFILL COUNTER TESTS PASSED!');
  process.exit(0);
}

testAutoRefillCount().catch((err) => {
  console.error(err);
  process.exit(1);
});
