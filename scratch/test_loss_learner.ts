import { initLossLearningEngine, evaluateCandidateAgainstLearnedPatterns, getLearnedLossDashboard, getLearnedLossContextForCoPilot, getLearnedFlopMemory } from '../src/services/lossLearner.js';
import { prisma } from '../src/services/db.js';

async function test() {
  console.log('🧪 Testing Adaptive Loss-Learning Feedback Engine...');

  // 1. Initialize engine
  await initLossLearningEngine();

  // 2. Fetch memory
  const memory = getLearnedFlopMemory();
  console.log(`✅ Memory loaded: ${memory.totalFlops} flops, ${memory.totalWinners} winners, winRate=${memory.winRatePct}%`);
  console.log(`✅ Danger zones: Max Safe MC=$${memory.dangerZones.maxSafeEntryMarketCap.toLocaleString()}, Min Liq Ratio=${(memory.dangerZones.minSafeLiquidityRatio * 100).toFixed(1)}%, Max Top 20=${memory.dangerZones.maxSafeTop20Pct}%, Max Dev=${memory.dangerZones.maxSafeDevHoldingPct}%`);
  console.log(`✅ Blacklisted serial ruggers count: ${memory.blacklistedDevCount}`);

  // 3. Test Flop Evaluation: Rotten Setup (Exhaustion MC + No Web + High Top 20 + High Dev)
  const badCandidate: any = {
    tokenMint: 'BadMint1111111111111111111111111111111111111',
    tokenSymbol: 'ROTTEN',
    tokenName: 'Rotten Coin',
    marketCap: 135_000, // Above $110k ceiling
    priceUsd: 0.00135,
    liquidityUsd: 6_000, // < 5% of MC
    ageMinutes: 4,
    top20Pct: 48,
    devHoldingPct: 8.5,
    buyPressurePct: 42,
    webUrl: '',
    xUrl: '',
  };

  const badEval = evaluateCandidateAgainstLearnedPatterns(badCandidate);
  console.log('\n--- EVALUATION: ROTTEN SETUP ---');
  console.log(`Passed: ${badEval.passed} (Expected: false)`);
  console.log(`Flop Risk Score: ${badEval.flopRiskScore}% (Expected: >= 60%)`);
  console.log(`Runner Match Score: ${badEval.runnerMatchScore}%`);
  console.log(`Penalties (${badEval.penalties.length}):`, badEval.penalties);
  console.log(`Rejection Reason: ${badEval.rejectionReason}`);

  if (badEval.passed) {
    throw new Error('FAILED: Rotten setup should have been rejected by the Loss Learner!');
  }

  // 4. Test Runner Evaluation: Golden Setup ($45k MC + Verified Web & Twitter + Low Dev + High Liq + High Buy Pressure)
  const goldenCandidate: any = {
    tokenMint: 'GoodMint2222222222222222222222222222222222222',
    tokenSymbol: 'GOLDEN',
    tokenName: 'Golden Runner',
    marketCap: 48_000,
    priceUsd: 0.000048,
    liquidityUsd: 12_000, // 25% of MC
    ageMinutes: 2,
    top20Pct: 24,
    devHoldingPct: 1.2,
    buyPressurePct: 78,
    webUrl: 'https://goldenrunner.fun',
    xUrl: 'https://x.com/goldenrunner',
  };

  const goodEval = evaluateCandidateAgainstLearnedPatterns(goldenCandidate);
  console.log('\n--- EVALUATION: GOLDEN SETUP ---');
  console.log(`Passed: ${goodEval.passed} (Expected: true)`);
  console.log(`Flop Risk Score: ${goodEval.flopRiskScore}% (Expected: <= 25%)`);
  console.log(`Runner Match Score: ${goodEval.runnerMatchScore}% (Expected: >= 70%)`);
  console.log(`Bonuses (${goodEval.bonuses.length}):`, goodEval.bonuses);

  if (!goodEval.passed) {
    throw new Error('FAILED: Golden setup should have been approved by the Loss Learner!');
  }

  // 5. Test Telegram Dashboard Generator
  const dashboard = getLearnedLossDashboard();
  console.log('\n--- TELEGRAM DASHBOARD PREVIEW ---');
  console.log(dashboard);

  // 6. Test Co-Pilot Grounding Text
  const copilotContext = getLearnedLossContextForCoPilot();
  console.log('\n--- CO-PILOT GROUNDING PREVIEW ---');
  console.log(copilotContext);

  console.log('\n🎉 ALL LOSS-LEARNER UNIT TESTS PASSED WITH 100% SUCCESS!');
  await prisma.$disconnect();
  process.exit(0);
}

test().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
