import { prisma } from '../src/services/db.js';
import { getDexScreenerUrl, escapeHtml, formatUsd } from '../src/services/telegram.js';

async function testRender() {
  const today = new Date().toISOString().slice(0, 10);
  let tokens = await prisma.earlyTrendingToken.findMany({
    where: { alertDate: today },
    orderBy: { createdAt: 'desc' },
  });

  if (tokens.length === 0) {
    tokens = await prisma.earlyTrendingToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  const flops = tokens
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
        isFlop: dropFromEntryPct < -20 || t.lastDipMilestonePct <= -50 || dropFromPeakPct <= -40,
      };
    })
    .filter((t) => t.isFlop)
    .sort((a, b) => a.dropFromEntryPct - b.dropFromEntryPct);

  let report = `📉 <b>DAILY FLOPPED COINS & DIPS</b> 🩸\n`;
  report += `<i>Tokens alerted today that dumped or suffered heavy drawdowns:</i>\n\n`;

  flops.slice(0, 10).forEach((t, i) => {
    const dexscreenerUrl = getDexScreenerUrl(t);
    const symbol = escapeHtml(t.tokenSymbol);
    const name = escapeHtml(t.tokenName || t.tokenSymbol);
    const entryMcStr = formatUsd(t.entryMarketCap);
    const currentMcStr = formatUsd(t.currentMarketCap);
    const rankEmoji = i === 0 ? '💀' : (i < 3 ? '🩸' : '📉');

    report += `${rankEmoji} <b>#${i + 1}.</b> <a href="${dexscreenerUrl}"><b>$${symbol}</b></a> (${name}) • <code>${t.dropFromEntryPct}%</code>\n`;
    report += `   💵 Entry: <code>${entryMcStr}</code> ➔ Now: <code>${currentMcStr}</code>\n`;
    if (t.peakPriceUsd > t.entryPriceUsd * 1.3) {
      report += `   ⚠️ Peak Drawdown: <code>${t.dropFromPeakPct}% from peak</code>\n`;
    }
    report += `   🔗 <a href="${dexscreenerUrl}">[DexScreener Live Chart]</a>\n\n`;
  });

  report += `🛡️ <i>Auto-Snipe protection: Trailing Stop-Loss cuts risk at -25% to protect capital!</i>`;

  console.log(report);
  process.exit(0);
}

testRender().catch(console.error);
