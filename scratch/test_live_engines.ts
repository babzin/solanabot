import { runEarlyTrendingRadarCycle } from '../src/services/earlyTrending.js';
import { checkPriceMilestones } from '../src/services/priceTracker.js';
import { prisma } from '../src/services/db.js';

async function test() {
  console.log('--- 1. Testing Early & Whale Radar Cycle ---');
  const newAlerts = await runEarlyTrendingRadarCycle();
  console.log(`Alerts dispatched in cycle: ${newAlerts}`);

  console.log('--- 2. Checking Database Records ---');
  const today = new Date().toISOString().slice(0, 10);
  const recorded = await prisma.earlyTrendingToken.findMany({
    where: { alertDate: today },
  });
  console.log(`Total tokens recorded for ${today}: ${recorded.length}/20`);
  for (const t of recorded) {
    console.log(`- #${t.dailyQuotaIndex} $${t.tokenSymbol} (${t.tokenName}): MC $${t.entryMarketCap.toFixed(0)} | Price $${t.entryPriceUsd}`);
  }

  console.log('--- 3. Testing Price Milestone Check ---');
  const milestoneAlerts = await checkPriceMilestones();
  console.log(`Milestone alerts evaluated: ${milestoneAlerts}`);

  await prisma.$disconnect();
  process.exit(0);
}

test().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
