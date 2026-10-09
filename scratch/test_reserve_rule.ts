import {
  initPaperTradingEngine,
  processPaperTradeBuy,
  checkPaperPositionsTpSl,
  getPaperPortfolioSummary,
  resetPaperTradingWallet,
  setPaperWalletCashForTesting,
  PAPER_RESERVE_FLOOR_USD,
  PAPER_TARGET_BALANCE_USD
} from '../src/services/paperTrading.js';

async function runTest() {
  console.log('🧪 === STARTING $20 RESERVE FLOOR & ZERO-PROFIT REFILL TEST ===\n');

  // 1. Reset to pristine state ($100)
  await resetPaperTradingWallet();
  let summary = await getPaperPortfolioSummary();
  console.log(`Initial Cash: $${summary.wallet.liquidCashUsd.toFixed(2)}, Refills: ${summary.wallet.autoRefillCount}`);

  // 2. Open a trade ($3)
  const pos1 = await processPaperTradeBuy({
    tokenMint: 'TestMint_Alpha_111',
    tokenSymbol: 'ALPHA',
    tokenName: 'Alpha Coin',
    priceUsd: 0.01,
    marketCap: 50000,
    liquidityUsd: 25000,
  });
  console.log(`Trade 1 opened: $${pos1?.tokenSymbol}, Invested: $${pos1?.investedUsd.toFixed(2)}`);

  // Artificially simulate liquid cash dropping to $20.00 while pos1 is still OPEN
  setPaperWalletCashForTesting(20.0);
  summary = await getPaperPortfolioSummary();
  console.log(`Simulated liquid cash at $${summary.wallet.liquidCashUsd.toFixed(2)} floor. Active positions count: ${summary.activePositions.length} (ALPHA)`);

  // 3. Try to open a second trade while at $20 floor with 1 active position open
  const pos2 = await processPaperTradeBuy({
    tokenMint: 'TestMint_Beta_222',
    tokenSymbol: 'BETA',
    tokenName: 'Beta Coin',
    priceUsd: 0.02,
    marketCap: 60000,
    liquidityUsd: 30000,
  });

  if (pos2 === null) {
    console.log('✅ TEST PASSED: System blocked new entry at $20 floor while active positions are running!');
  } else {
    throw new Error('❌ TEST FAILED: System should not have traded below $20 reserve floor while open positions exist!');
  }

  // Verify wallet still has $20.00 (not a single cent deducted)
  summary = await getPaperPortfolioSummary();
  console.log(`Wallet cash after attempted entry: $${summary.wallet.liquidCashUsd.toFixed(2)}`);
  if (summary.wallet.liquidCashUsd === 20.0) {
    console.log('✅ TEST PASSED: $20 capital reserve remained 100% untouched!');
  } else {
    throw new Error(`❌ TEST FAILED: $20 capital reserve was modified! Current cash: ${summary.wallet.liquidCashUsd}`);
  }

  // 4. Verify pos1 hits 2X Take Profit -> Profit enters wallet!
  console.log('\n--- Simulating 2X Take-Profit Pump on ALPHA (+100%) ---');
  await checkPaperPositionsTpSl('TestMint_Alpha_111', 0.02); // 2X of 0.01

  summary = await getPaperPortfolioSummary();
  console.log(`Liquid cash after 2X TP profit entered: $${summary.wallet.liquidCashUsd.toFixed(2)}`);
  if (summary.wallet.liquidCashUsd > 20.0) {
    console.log('✅ TEST PASSED: Profit successfully entered wallet, bringing cash above $20 floor!');
  } else {
    throw new Error('❌ TEST FAILED: Liquid cash should have increased above $20 floor upon TP!');
  }

  // 5. Test Zero-Profit Refill Condition:
  // Now simulate trailing stop closing ALPHA, and cash dropping to $20.00 with 0 active positions remaining!
  console.log('\n--- Simulating Trailing Stop Exit on ALPHA (Closes position completely) ---');
  // Trailing drop from peak (0.02 peak, drops to 0.015 = 25% drop)
  await checkPaperPositionsTpSl('TestMint_Alpha_111', 0.015);

  summary = await getPaperPortfolioSummary();
  console.log(`Active positions count after trailing stop: ${summary.activePositions.length}`);

  // Now simulate cash is at $20.00 (or $19.50) with 0 active positions:
  setPaperWalletCashForTesting(20.0);
  console.log(`Cash is $20.00 with 0 open positions ("no profit at all" left to wait for).`);

  // Next candidate arrives:
  const pos3 = await processPaperTradeBuy({
    tokenMint: 'TestMint_Gamma_333',
    tokenSymbol: 'GAMMA',
    tokenName: 'Gamma Coin',
    priceUsd: 0.05,
    marketCap: 100000,
    liquidityUsd: 50000,
  });

  summary = await getPaperPortfolioSummary();
  console.log(`Refill count: ${summary.wallet.autoRefillCount}`);
  console.log(`Total refilled: $${summary.wallet.totalRefilledUsd.toFixed(2)}`);
  console.log(`Liquid cash after top-up and buy: $${summary.wallet.liquidCashUsd.toFixed(2)}`);

  if (summary.wallet.autoRefillCount >= 1 && summary.wallet.totalRefilledUsd >= 80.0) {
    console.log('✅ TEST PASSED: System added money to existing balance to take paper money back to $100 when zero profit remained!');
  } else {
    throw new Error(`❌ TEST FAILED: Refill did not execute as expected. RefillCount: ${summary.wallet.autoRefillCount}, TotalRefilled: ${summary.wallet.totalRefilledUsd}`);
  }

  console.log('\n🎉 ALL $20 RESERVE AND CONDITIONAL REFILL TESTS PASSED PERFECTLY!');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
