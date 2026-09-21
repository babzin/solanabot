import { prisma } from '../src/services/db.js';

async function purgeStale() {
  console.log('Purging stale test tokens with null age or older than 1 hour...');
  const res = await prisma.earlyTrendingToken.deleteMany({
    where: {
      OR: [
        { ageMinutes: null },
        { pairCreatedAt: null },
        { status: 'STOPPED' }
      ]
    }
  });
  console.log(`Purged ${res.count} stale test tokens.`);
  const remaining = await prisma.earlyTrendingToken.count();
  console.log(`Remaining active tokens: ${remaining}`);
}

purgeStale()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
