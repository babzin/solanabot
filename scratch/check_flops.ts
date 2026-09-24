import { prisma } from '../src/services/db.js';

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const tokens = await prisma.earlyTrendingToken.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  console.log(`Total tokens in DB: ${tokens.length}`);
  
  const tokenStats = tokens.map((t) => {
    const dropFromEntryPct = t.entryPriceUsd > 0
      ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
      : 0;
    const dropFromPeakPct = t.peakPriceUsd > 0
      ? ((t.lastAlertedPriceUsd - t.peakPriceUsd) / t.peakPriceUsd) * 100
      : 0;

    return {
      symbol: t.tokenSymbol,
      alertDate: t.alertDate,
      entryMc: t.entryMarketCap,
      entryPrice: t.entryPriceUsd,
      lastPrice: t.lastAlertedPriceUsd,
      peakPrice: t.peakPriceUsd,
      dropFromEntryPct: Number(dropFromEntryPct.toFixed(1)),
      dropFromPeakPct: Number(dropFromPeakPct.toFixed(1)),
      dipMilestone: t.lastDipMilestonePct,
      milestonePct: t.lastMilestonePct,
    };
  });

  console.log('\n--- ALL TOKENS ---');
  console.table(tokenStats);

  const flops = tokenStats.filter((t) => t.dropFromEntryPct < -20 || t.dipMilestone <= -50 || t.dropFromPeakPct <= -40);
  console.log('\n--- FLOPPED / BAD COINS ---');
  console.table(flops);

  process.exit(0);
}

main().catch(console.error);
