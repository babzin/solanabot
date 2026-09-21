import { prisma } from '../src/services/db.js';
import { checkPriceMilestones } from '../src/services/priceTracker.js';

async function testMilestone() {
  console.log('Testing milestone alert triggering...');
  // Find one of our test tokens
  const token = await prisma.earlyTrendingToken.findFirst({
    where: { status: 'ACTIVE' },
  });

  if (!token) {
    console.log('No token found');
    return;
  }

  // Artificially simulate that the token entry was lower so that current price triggers a +50% milestone
  const originalEntry = token.entryPriceUsd;
  await prisma.earlyTrendingToken.update({
    where: { id: token.id },
    data: {
      entryPriceUsd: token.entryPriceUsd * 0.6, // Simulates a +66% gain relative to this entry
      lastMilestonePct: 0,
    },
  });

  console.log(`Set simulated lower entry for ${token.tokenSymbol}. Running checkPriceMilestones()...`);
  const dispatched = await checkPriceMilestones();
  console.log(`Milestones dispatched: ${dispatched}`);

  // Restore original entry price
  await prisma.earlyTrendingToken.update({
    where: { id: token.id },
    data: {
      entryPriceUsd: originalEntry,
      lastMilestonePct: 0,
    },
  });
  console.log('Restored original entry price. Test complete.');

  await prisma.$disconnect();
  process.exit(0);
}

testMilestone().catch((err) => {
  console.error(err);
  process.exit(1);
});
