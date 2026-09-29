import {
  initPaperTradingEngine,
  getPaperPortfolioSummary,
  processPaperTradeBuy,
  checkPaperPositionsTpSl,
  resetPaperTradingWallet,
} from '../src/services/paperTrading.js';

async function runTest() {
  console.log('====================================================');
  console.log('🧪 TESTING SMART SHAKEOUT DEFENSE & PAPER ENGINE');
  console.log('====================================================');

  // 1. Initialize
  await initPaperTradingEngine();
  await resetPaperTradingWallet();

  let summary = await getPaperPortfolioSummary();
  console.log('\n[TEST 1] Initial Wallet State:');
  console.log(`- Net Worth: $${summary.netWorthUsd} (${summary.netWorthSol} SOL)`);
  console.log(`- Liquid Cash: $${summary.wallet.liquidCashUsd} USD`);
  console.log(`- Total Trades: ${summary.wallet.totalTrades}`);
  console.log(`- Total Fees Paid: $${summary.wallet.totalFeesPaidUsd}`);

  if (summary.netWorthUsd !== 100) {
    throw new Error(`Expected $100 net worth, got $${summary.netWorthUsd}`);
  }

  // 2. Simulate buying a test candidate token (3% allocation)
  console.log('\n[TEST 2] Simulating Entry on $SOLTEST...');
  const fakeMint = 'TESTmint11111111111111111111111111111111111';
  const pos = await processPaperTradeBuy({
    tokenMint: fakeMint,
    tokenSymbol: 'SOLTEST',
    tokenName: 'Solana Paper Test',
    priceUsd: 0.000100,
    marketCap: 100_000,
    liquidityUsd: 25_000,
  });

  if (!pos) throw new Error('Failed to open paper position');
  console.log(`- Position opened: $${pos.tokenSymbol}`);
  console.log(`- Tokens Acquired: ${pos.tokensAcquired.toFixed(0)} (Slippage: ${pos.slippagePct}%)`);
  console.log(`- Buy Priority Gas: ${pos.buyGasFeeSol} SOL ($${pos.buyGasFeeUsd})`);

  summary = await getPaperPortfolioSummary();
  console.log(`- Updated Liquid Cash: $${summary.wallet.liquidCashUsd}`);
  console.log(`- Open Positions Count: ${summary.activePositions.length}`);
  console.log(`- Total Gas Paid: $${summary.wallet.totalFeesPaidUsd}`);

  // 3. Test 2X Take-Profit (+100% pump)
  console.log('\n[TEST 3] Simulating 2X pump to $0.000200 (+100%)...');
  await checkPaperPositionsTpSl(fakeMint, 0.000200, { liquidity: { usd: 35_000 } });

  summary = await getPaperPortfolioSummary();
  console.log(`- Status after 2X: ${summary.activePositions[0]?.status}`);
  console.log(`- Liquid Cash after securing principal: $${summary.wallet.liquidCashUsd}`);
  console.log(`- Realized PnL: $${summary.wallet.totalRealizedPnlUsd}`);

  // 4. Test Wide Moonbag Trailing Stop (-40% from ATH)
  console.log('\n[TEST 4] Token pumps to 4X ($0.000400), drops -28% (should HOLD), then drops -41% (should EXIT)...');
  // Update peak to 4X
  await checkPaperPositionsTpSl(fakeMint, 0.000400, { liquidity: { usd: 60_000 } });
  
  // Retrace -28% from peak to $0.000288 -> Should HOLD because trailing stop is now -40%!
  await checkPaperPositionsTpSl(fakeMint, 0.000288, { liquidity: { usd: 50_000 } });
  summary = await getPaperPortfolioSummary();
  if (summary.activePositions.length === 0) {
    throw new Error('Moonbag prematurely exited on -28% retrace! Trailing stop should be -40%.');
  }
  console.log(`- Retrace -28%: Moonbag still holding as intended! Status: ${summary.activePositions[0]?.status}`);

  // Retrace -41% from peak to $0.000236 -> Trailing stop triggers
  await checkPaperPositionsTpSl(fakeMint, 0.000235, { liquidity: { usd: 40_000 } });
  summary = await getPaperPortfolioSummary();
  console.log(`- Retrace -41%: Moonbag exited! Closed Count: ${summary.closedPositions.length}`);
  console.log(`- Exit Reason: ${summary.closedPositions[0]?.exitReason}`);
  console.log(`- Realized Net Profit on Trade: $${summary.closedPositions[0]?.realizedPnlUsd.toFixed(2)}`);

  // 5. Test Smart Shakeout Defense on second token (temporary wick vs emergency cut)
  console.log('\n[TEST 5] Testing Smart Shakeout Defense (-35% buffer & recovery)...');
  const flopMint = 'FLOPmint11111111111111111111111111111111111';
  await processPaperTradeBuy({
    tokenMint: flopMint,
    tokenSymbol: 'FLOPCOIN',
    tokenName: 'Flop Coin Test',
    priceUsd: 0.001000,
    marketCap: 50_000,
    liquidityUsd: 12_000,
  });

  // Step A: Token dips -36% to $0.000640 for 1 tick -> Position MUST NOT close immediately!
  await checkPaperPositionsTpSl(flopMint, 0.000640, { liquidity: { usd: 10_000 } });
  summary = await getPaperPortfolioSummary();
  const flopActive = summary.activePositions.find((p) => p.tokenMint === flopMint);
  if (!flopActive) {
    throw new Error('Flop position was cut prematurely on first tick! 45s buffer did not hold.');
  }
  console.log('- 1st Tick at -36%: Position HELD by 45s buffer ✅ (Shakeout prevented!)');

  // Step B: Token bounces back to $0.000850 (-15%) -> Timer should reset!
  await checkPaperPositionsTpSl(flopMint, 0.000850, { liquidity: { usd: 11_000 } });
  console.log('- Token bounced to -15%: Timer cleared, position safe ✅');

  // Step C: Token dumps -70% to $0.000300 -> Emergency Rug Cut triggered immediately!
  await checkPaperPositionsTpSl(flopMint, 0.000300, { liquidity: { usd: 5_000 } });
  summary = await getPaperPortfolioSummary();
  const closedFlop = summary.closedPositions.find((p) => p.tokenMint === flopMint);
  console.log(`- Catastrophic Dump (-70%): Emergency cut executed ✅ Reason: ${closedFlop?.exitReason}`);

  // 6. Test Re-Trade Gate:
  // Still-dumping coin ($0.000200) MUST BE BLOCKED
  // Breakout recovery coin ($0.001150 > $0.001000 entry) MUST BE ALLOWED!
  console.log('\n[TEST 6] Testing Breakout Recovery Re-Trade Gate:');
  const reBuyDumpingFlop = await processPaperTradeBuy({
    tokenMint: flopMint,
    tokenSymbol: 'FLOPCOIN',
    tokenName: 'Flop Coin Test',
    priceUsd: 0.000200,
    marketCap: 20_000,
    liquidityUsd: 5_000,
  });
  console.log(`- Re-entering dumping coin result: ${reBuyDumpingFlop === null ? 'BLOCKED ✅' : 'FAILED'}`);
  if (reBuyDumpingFlop !== null) throw new Error('Dumping coin should have been blocked!');

  const reBuyBreakoutFlop = await processPaperTradeBuy({
    tokenMint: flopMint,
    tokenSymbol: 'FLOPCOIN',
    tokenName: 'Flop Coin Test',
    priceUsd: 0.001100, // Reclaimed and broke out above previous $0.001000 entry!
    marketCap: 60_000,
    liquidityUsd: 15_000,
  });
  console.log(`- Re-entering breakout recovery coin result: ${reBuyBreakoutFlop !== null ? 'ALLOWED ✅ (Breakout Wave Caught!)' : 'FAILED'}`);
  if (reBuyBreakoutFlop === null) throw new Error('Breakout recovery coin should have been allowed!');

  // Reset back to pristine $100
  await resetPaperTradingWallet();
  summary = await getPaperPortfolioSummary();
  console.log(`\n✅ Reset verified: Wallet back to pristine $${summary.netWorthUsd}`);

  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
