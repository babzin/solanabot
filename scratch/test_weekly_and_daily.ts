import { prisma } from '../src/services/db.js';
import { getWeekDates, calculateWeeklyStats, renderWeeklyReportText } from '../src/services/weeklyReport.js';
import { formatDisplayDate, renderTopLeaderboardText } from '../src/services/telegram.js';

async function main() {
  console.log('====================================================');
  console.log('🧪 TESTING STRICT DAILY DATES & WEEKLY REPORT');
  console.log('====================================================');

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n📅 Today (ISO): ${today}`);
  console.log(`📅 Today (Formatted): ${formatDisplayDate(today)}`);

  // 1. Test getWeekDates
  const weekInfo = getWeekDates(0);
  console.log(`\n🗓️ Current Week Label: ${weekInfo.label}`);
  console.log(`🗓️ Week Days in Range:`, weekInfo.dates);

  // 2. Test calculateWeeklyStats
  const weeklyStats = await calculateWeeklyStats(0, 0.1, 160.0);
  console.log(`\n📊 Weekly Stats Calculated:`, {
    weekLabel: weeklyStats.weekLabel,
    totalSignals: weeklyStats.totalSignals,
    wins: weeklyStats.winsCount,
    flops: weeklyStats.flopsCount,
    winRate: `${weeklyStats.winRatePercent}%`,
    totalWinMultiplier: `+${weeklyStats.totalWinMultiplier}X`,
    totalDrawdownMultiplier: `-${weeklyStats.totalDrawdownMultiplier}X`,
    netMultiplier: `${weeklyStats.netMultiplier}X`,
    grossSolMade: `+${weeklyStats.grossSolMade} SOL`,
    grossSolLost: `-${weeklyStats.grossSolLost} SOL`,
    netSolPnL: `${weeklyStats.netSolPnL} SOL`,
    netUsdPnL: `$${weeklyStats.netUsdPnL}`,
    bestDay: weeklyStats.bestDay,
    worstDay: weeklyStats.worstDay,
    dailyBreakdown: weeklyStats.dailyBreakdown,
  });

  // 3. Test renderWeeklyReportText
  console.log('\n--- 📱 TELEGRAM WEEKLY REPORT TEXT ---');
  const weeklyReport = renderWeeklyReportText(weeklyStats);
  console.log(weeklyReport);

  // 4. Test Top Leaderboard with strict today date
  console.log('\n--- 🏆 TOP GAINERS CARD (TODAY ONLY) ---');
  const todayTokens = await prisma.earlyTrendingToken.findMany({
    where: { alertDate: today },
    orderBy: { lastMilestonePct: 'desc' },
  });
  console.log(`Today's token count in DB: ${todayTokens.length}`);
  if (todayTokens.length > 0) {
    console.log(renderTopLeaderboardText(todayTokens.slice(0, 5), today));
  } else {
    console.log(`Clean empty state for today (${today}): No tokens yet for today, radar scanning!`);
  }

  // 5. Test flops strictly for today
  console.log('\n--- 📉 FLOPS CARD (TODAY ONLY) ---');
  const todayFlops = todayTokens.filter(t => {
    const dropFromEntryPct = t.entryPriceUsd > 0
      ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
      : 0;
    return dropFromEntryPct <= -20;
  });
  console.log(`Today's flop count: ${todayFlops.length}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
