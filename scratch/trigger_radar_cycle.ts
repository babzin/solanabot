import { runEarlyTrendingRadarCycle } from '../src/services/earlyTrending.js';
import { prisma } from '../src/services/db.js';

async function main() {
  console.log('Running Early Trending Radar cycle with real 1m-15m filter...');
  const count = await runEarlyTrendingRadarCycle();
  console.log(`Dispatched: ${count} gems.`);
  
  const tokens = await prisma.earlyTrendingToken.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(`Active tokens in DB now: ${tokens.length}`);
  for (const t of tokens) {
    console.log(`- ${t.tokenSymbol} | Age: ${t.ageMinutes}m | CreatedAt: ${t.pairCreatedAt} | MC: $${t.entryMarketCap}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
