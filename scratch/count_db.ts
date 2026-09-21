import { prisma } from '../src/services/db.js';

async function main() {
  const all = await prisma.earlyTrendingToken.findMany({
    select: { id: true, tokenSymbol: true, tokenMint: true, ageMinutes: true, pairCreatedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
  console.log(`Total tokens in DB: ${all.length}`);
  for (const t of all.slice(0, 5)) {
    console.log(`- ${t.tokenSymbol} (${t.tokenMint}) | ageMinutes: ${t.ageMinutes} | pairCreatedAt: ${t.pairCreatedAt}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
