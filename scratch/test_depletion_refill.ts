import { processPaperTradeBuy, getPaperPortfolioSummary } from '../src/services/paperTrading.js';

async function testDepletionRefill() {
  console.log('🧪 [TEST] Verifying auto-refill triggers and increments counter upon paper funds depletion...');

  // Drain cash by simulating high allocations or checking current liquid cash
  const initial = await getPaperPortfolioSummary();
  const initialCount = initial.wallet.autoRefillCount || 0;
  console.log(`Starting refill count: ${initialCount}, Liquid Cash: $${initial.wallet.liquidCashUsd.toFixed(2)}`);

  // Enter multiple positions with 3% allocation until cash drops below trade size
  // To reach depletion quickly, we will enter 35 distinct tokens
  let triggeredRefill = false;
  for (let i = 1; i <= 40; i++) {
    const mint = `DepleteMint_${Date.now()}_${i}`;
    const p = await processPaperTradeBuy({
      tokenMint: mint,
      tokenSymbol: `DEP_${i}`,
      tokenName: `Deplete Token ${i}`,
      priceUsd: 0.001,
      marketCap: 60000,
      liquidityUsd: 30000,
      aiScore: {
        convictionScore: 85,
        rugRisk: 'LOW',
        strategyProfile: 'BALANCED_MOMENTUM',
        suggestedAllocationPct: 3.0,
      },
    });

    const s = await getPaperPortfolioSummary();
    if (s.wallet.autoRefillCount > initialCount) {
      triggeredRefill = true;
      console.log(`🎯 Refill triggered successfully on token DEP_${i}!`);
      console.log(`   Refill Count: ${s.wallet.autoRefillCount} times`);
      console.log(`   Total Refilled Amount: +$${s.wallet.totalRefilledUsd.toFixed(2)} USD`);
      console.log(`   Liquid Cash after refill: $${s.wallet.liquidCashUsd.toFixed(2)} USD`);
      break;
    }
  }

  if (!triggeredRefill) {
    throw new Error('❌ Test FAILED: Auto-refill was not triggered!');
  }

  const finalSummary = await getPaperPortfolioSummary();
  console.log(`\nFinal Portfolio Verification:`);
  console.log(`• Auto-Refills: ${finalSummary.autoRefillCount} time(s)`);
  console.log(`• Total Cumulative Refilled: +$${finalSummary.totalRefilledUsd.toFixed(2)} USD`);

  console.log('\n🎉 ALL DEPLETION REFILL TESTS PASSED PERFECTLY!');
  process.exit(0);
}

testDepletionRefill().catch((err) => {
  console.error(err);
  process.exit(1);
});
