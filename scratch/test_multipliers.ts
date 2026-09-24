import { prisma } from '../src/services/db.js';
import { getDexScreenerUrl, escapeHtml, formatUsd } from '../src/services/telegram.js';

async function testBoth() {
  const today = new Date().toISOString().slice(0, 10);
  let tokens = await prisma.earlyTrendingToken.findMany({
    orderBy: { lastMilestonePct: 'desc' },
    take: 25,
  });

  // 1. TOP GAINERS
  tokens.sort((a, b) => {
    const multA = a.peakPriceUsd && a.entryPriceUsd && a.entryPriceUsd > 0
      ? a.peakPriceUsd / a.entryPriceUsd
      : (1 + (a.lastMilestonePct || 0) / 100);
    const multB = b.peakPriceUsd && b.entryPriceUsd && b.entryPriceUsd > 0
      ? b.peakPriceUsd / b.entryPriceUsd
      : (1 + (b.lastMilestonePct || 0) / 100);
    return multB - multA;
  });

  const top15 = tokens.slice(0, 15);
  let totalMultiplier = 0;
  top15.forEach((t) => {
    let multVal = 1.0;
    if (t.peakPriceUsd && t.entryPriceUsd && t.entryPriceUsd > 0) {
      multVal = t.peakPriceUsd / t.entryPriceUsd;
    } else if (t.lastMilestonePct && t.lastMilestonePct > 0) {
      multVal = 1 + t.lastMilestonePct / 100;
    }
    totalMultiplier += multVal;
  });

  const roundedTopX = Math.round(totalMultiplier);

  console.log('=== TOP GAINERS CARD ===');
  console.log(`🏆 <b>Top Early Trending</b> 💸`);
  console.log(`🚀 <b>Total Multiplier:</b> <code>+${roundedTopX}X</code> • <i>(all coins make a total of ${roundedTopX}X)</i>\n`);

  // 2. DAILY FLOPS
  const allTokens = await prisma.earlyTrendingToken.findMany({
    where: { alertDate: today },
    orderBy: { createdAt: 'desc' },
  });

  const targetTokens = allTokens.length > 0 ? allTokens : tokens;

  const flops = targetTokens
    .map((t) => {
      const dropFromEntryPct = t.entryPriceUsd > 0
        ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
        : 0;
      const dropFromPeakPct = t.peakPriceUsd > 0
        ? ((t.lastAlertedPriceUsd - t.peakPriceUsd) / t.peakPriceUsd) * 100
        : dropFromEntryPct;
      const currentMc = t.entryPriceUsd > 0
        ? (t.lastAlertedPriceUsd / t.entryPriceUsd) * t.entryMarketCap
        : t.entryMarketCap;

      return {
        ...t,
        dropFromEntryPct: Number(dropFromEntryPct.toFixed(1)),
        dropFromPeakPct: Number(dropFromPeakPct.toFixed(1)),
        currentMarketCap: Math.round(currentMc),
        isFlop: dropFromEntryPct <= -20 || (dropFromPeakPct <= -45 && dropFromEntryPct <= 10) || (t.lastDipMilestonePct === -50 && dropFromEntryPct <= -30),
      };
    })
    .filter((t) => t.isFlop)
    .sort((a, b) => a.dropFromEntryPct - b.dropFromEntryPct);

  let totalFlopDropPct = 0;
  flops.forEach((f) => {
    totalFlopDropPct += Math.abs(f.dropFromEntryPct);
  });
  const totalFlopMultiplier = (totalFlopDropPct / 100).toFixed(1);
  const roundedFlopDropPct = Math.round(totalFlopDropPct);

  console.log('=== DAILY FLOPS CARD ===');
  console.log(`📉 <b>DAILY FLOPPED COINS & DIPS</b> 🩸`);
  console.log(`🩸 <b>Total Drawdown:</b> <code>-${totalFlopMultiplier}X</code> (<code>-${roundedFlopDropPct}%</code>) • <i>(all coins make a total of -${totalFlopMultiplier}X / -${roundedFlopDropPct}%)</i>`);
  console.log(`<i>Tokens alerted today that dumped or suffered heavy drawdowns:</i>\n`);

  process.exit(0);
}

testBoth().catch(console.error);
