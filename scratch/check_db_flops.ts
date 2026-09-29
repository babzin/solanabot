import { prisma } from '../src/services/db.js';

async function check() {
  const total = await prisma.earlyTrendingToken.count();
  const flops = await prisma.earlyTrendingToken.findMany({
    where: {
      OR: [
        { lastDipMilestonePct: { lte: -25 } },
        { lowestPriceUsd: { lt: prisma.earlyTrendingToken.fields.entryPriceUsd } }
      ]
    },
    take: 10,
    orderBy: { createdAt: 'desc' }
  });

  const winners = await prisma.earlyTrendingToken.findMany({
    where: { lastMilestonePct: { gte: 50 } },
    take: 10,
    orderBy: { lastMilestonePct: 'desc' }
  });

  console.log(`Total Tokens: ${total}`);
  console.log(`Sample Flops count: ${flops.length}`);
  flops.forEach(f => {
    const drop = f.entryPriceUsd > 0 ? ((f.lowestPriceUsd - f.entryPriceUsd) / f.entryPriceUsd) * 100 : 0;
    console.log(`FLOP: $${f.tokenSymbol} (${f.tokenName}) | Drop: ${drop.toFixed(1)}% | Dev: ${f.devHoldingPct}% | Top20: ${f.top20Pct}% | Liq: $${f.liquidityUsd} | MC: $${f.entryMarketCap} | Socials: X=${!!f.xUrl}, Web=${!!f.webUrl}`);
  });

  console.log(`\nSample Winners count: ${winners.length}`);
  winners.forEach(w => {
    console.log(`WINNER: $${w.tokenSymbol} (+${w.lastMilestonePct}%) | Dev: ${w.devHoldingPct}% | Top20: ${w.top20Pct}% | Liq: $${w.liquidityUsd} | MC: $${w.entryMarketCap} | Socials: X=${!!w.xUrl}, Web=${!!w.webUrl}`);
  });
}

check().catch(console.error);
