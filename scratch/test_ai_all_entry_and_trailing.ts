import { processPaperTradeBuy, checkPaperPositionsTpSl, getPaperPortfolioSummary } from '../src/services/paperTrading.js';

async function testAllCoinsEntryAndTrailing() {
  console.log('🧪 [TEST] Verifying: Enter every coin given by AI & trailing stop / cashing out rules');

  // =========================================================================
  // TEST 1: Low AI Conviction (15/100) + HIGH Rug Risk (Previously rejected)
  // =========================================================================
  console.log('\n--- Test 1: Low AI Conviction (15/100) & High Rug Risk ---');
  const mint1 = 'LowConvictionMint_' + Date.now();
  const entryPrice = 0.0001;

  const pos1 = await processPaperTradeBuy({
    tokenMint: mint1,
    tokenSymbol: 'LOWCONV',
    tokenName: 'Low Conviction Token',
    priceUsd: entryPrice,
    marketCap: 25000,
    liquidityUsd: 10000,
    aiScore: {
      convictionScore: 15, // Extremely low conviction (previously vetoed by conviction < 50)
      rugRisk: 'HIGH',     // High rug risk (previously vetoed)
      strategyProfile: 'BALANCED_MOMENTUM',
      targetMultiplier: 3,
      thesis: 'High sniper density, copycat narrative, but entering unconditionally in paper trading.',
      suggestedAllocationPct: 1.0,
    },
    learnedRisk: {
      flopRiskScore: 85,   // Flop learner warns high risk
      reasons: ['Dev dumped 20%'],
    },
  });

  if (!pos1) {
    throw new Error('❌ Test 1 FAILED: Low conviction coin was rejected by paper trading!');
  }
  console.log(`✅ Test 1 PASSED: Low conviction coin $${pos1.tokenSymbol} was successfully entered!`);
  console.log(`   Tokens: ${pos1.tokensAcquired.toFixed(2)}, Invested: $${pos1.investedUsd.toFixed(2)}`);

  // =========================================================================
  // TEST 2: Trailing and Cashing Out Lifecycle
  // =========================================================================
  console.log('\n--- Test 2: Cashing out at 2.0X (De-risking) & Uncapped Trailing Stop ---');

  const summaryBefore = await getPaperPortfolioSummary();
  const cashBefore = summaryBefore.wallet.liquidCashUsd;

  console.log(`Initial tokens in pos1: ${pos1.initialTokens}, remaining: ${pos1.remainingTokens}`);
  console.log(`Pumping price to $${(entryPrice * 2).toFixed(6)} (2.0X / +100%)...`);
  
  await checkPaperPositionsTpSl(mint1, entryPrice * 2.0, { liquidity: { usd: 30000 } });
  
  if (!pos1.tp1Hit || pos1.status !== 'PARTIAL_TP_2X') {
    throw new Error(`❌ Test 2a FAILED: 2.0X Take-profit was not hit! Status: ${pos1.status}, tp1Hit: ${pos1.tp1Hit}`);
  }
  const summaryAfter2x = await getPaperPortfolioSummary();
  console.log(`✅ Test 2a PASSED: 2.0X De-risking executed!`);
  console.log(`   Tokens remaining: ${pos1.remainingTokens} (50% remaining for uncapped moonbag)`);
  console.log(`   Cash returned: +$${(summaryAfter2x.wallet.liquidCashUsd - cashBefore).toFixed(2)} USD (Principal secured)`);

  // Step 2b: Price continues pumping to 3.0X, 5.0X, 10.0X (NO CAP CHECK)
  console.log(`\nPumping price to $${(entryPrice * 5).toFixed(6)} (5.0X)...`);
  await checkPaperPositionsTpSl(mint1, entryPrice * 5.0, { liquidity: { usd: 30000 } });
  if (pos1.status === 'CLOSED') {
    throw new Error(`❌ Test 2b FAILED: Position was capped/closed at 5.0X! It must ride uncapped.`);
  }

  console.log(`Pumping price to $${(entryPrice * 12).toFixed(6)} (12.0X Mega Moonshot)...`);
  await checkPaperPositionsTpSl(mint1, entryPrice * 12.0, { liquidity: { usd: 50000 } });
  if (pos1.status === 'CLOSED') {
    throw new Error(`❌ Test 2b FAILED: Position was capped/closed at 12.0X! It must ride uncapped.`);
  }
  console.log(`✅ Test 2b PASSED: Runner rode all the way to 12.0X without any fixed cap exit! Peak: ${pos1.peakMultiplier}X`);

  // Step 2c: Price minor pullback (-10% from peak) -> Should NOT trigger trailing stop (threshold is 18%)
  const peakPrice = entryPrice * 12.0;
  const minorPullbackPrice = peakPrice * 0.90; // -10%
  console.log(`\nMinor pullback to $${minorPullbackPrice.toFixed(6)} (-10% from peak)...`);
  await checkPaperPositionsTpSl(mint1, minorPullbackPrice, { liquidity: { usd: 50000 } });
  if (pos1.status === 'CLOSED') {
    throw new Error(`❌ Test 2c FAILED: Position closed on minor -10% pullback (trailing stop is 18%)!`);
  }
  console.log(`✅ Test 2c PASSED: Minor pullback held successfully. Still OPEN.`);

  // Step 2d: Price trails down by -21% from peak (Exceeds 18% trailing stop threshold) -> MUST exit and cash out!
  const trailingStopPrice = peakPrice * 0.79; // -21% from peak
  console.log(`\nMarket trailing down to $${trailingStopPrice.toFixed(6)} (-21% from peak)...`);
  await checkPaperPositionsTpSl(mint1, trailingStopPrice, { liquidity: { usd: 50000 } });

  if (pos1.status !== 'CLOSED' || pos1.exitReason !== 'TRAILING_STOP') {
    throw new Error(`❌ Test 2d FAILED: Trailing stop did not exit! Status: ${pos1.status}, exitReason: ${pos1.exitReason}`);
  }
  console.log(`✅ Test 2d PASSED: Trailing stop executed perfectly!`);
  console.log(`   Exit Reason: ${pos1.exitReason}`);
  console.log(`   Realized Net Profit: +$${pos1.realizedPnlUsd.toFixed(2)} USD`);

  const summaryFinal = await getPaperPortfolioSummary();
  console.log(`   Final Wallet Cash: $${summaryFinal.wallet.liquidCashUsd.toFixed(2)} USD`);

  console.log('\n🎉 ALL TESTS PASSED! Both requirements are 100% verified.');
  process.exit(0);
}

testAllCoinsEntryAndTrailing().catch((err) => {
  console.error(err);
  process.exit(1);
});
