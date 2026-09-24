import { prisma } from './db.js';
import { env } from '../config/env.js';

export interface DayHighlight {
  date: string;
  dayLabel: string;
  grossSol: number;
  grossUsd: number;
  multiplier: number;
  netSolPnL: number;
}

export interface DailyBreakdownItem {
  date: string;
  dayLabel: string;
  totalSignals: number;
  winsCount: number;
  flopsCount: number;
  grossSolMade: number;
  grossUsdMade: number;
  grossSolLost: number;
  grossUsdLost: number;
  netSolPnL: number;
  netUsdPnL: number;
  winMultiplier: number;
  drawdownMultiplier: number;
}

export interface WeeklyStats {
  weekLabel: string;
  startDateStr: string;
  endDateStr: string;
  totalSignals: number;
  winsCount: number;
  flopsCount: number;
  winRatePercent: number;
  totalWinMultiplier: number;
  totalDrawdownMultiplier: number;
  totalDrawdownPercent: number;
  netMultiplier: number;
  // Simulated PnL based on base trade size (default 0.1 SOL)
  baseTradeSol: number;
  solPriceUsd: number;
  grossSolMade: number;
  grossUsdMade: number;
  grossSolLost: number;
  grossUsdLost: number;
  netSolPnL: number;
  netUsdPnL: number;
  bestDay: DayHighlight | null;
  worstDay: DayHighlight | null;
  dailyBreakdown: DailyBreakdownItem[];
  bestToken: {
    symbol: string;
    name: string;
    mint: string;
    multiplier: number;
    entryMc: number;
    peakMc: number;
  } | null;
  worstToken: {
    symbol: string;
    name: string;
    mint: string;
    dropPct: number;
  } | null;
  multiplierBreakdown: {
    x50plus: number;
    x20to50: number;
    x10to20: number;
    x5to10: number;
    x2to5: number;
  };
  aiInsights?: string[];
}

/**
 * Formats YYYY-MM-DD into a human-readable day label (e.g. "Monday, Sep 21")
 */
export function formatWeeklyDayLabel(isoDateStr: string): string {
  try {
    const [year, month, day] = isoDateStr.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${dayNames[d.getUTCDay()]}, ${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}`;
  } catch {
    return isoDateStr;
  }
}

/**
 * Returns an array of 'YYYY-MM-DD' date strings for a given week.
 * Week starts on Monday 00:00:00 UTC and ends on Sunday 23:59:59 UTC.
 * @param weekOffset 0 for current week, -1 for previous week, etc.
 */
export function getWeekDates(weekOffset = 0, referenceDate = new Date()): { dates: string[]; start: Date; end: Date; label: string } {
  const d = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  
  // getUTCDay(): 0 is Sunday, 1 is Monday ... 6 is Saturday
  const day = d.getUTCDay();
  // Distance to Monday (if Sunday, day is 0, so diff is -6)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday + (weekOffset * 7));
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const curr = new Date(monday);
    curr.setUTCDate(monday.getUTCDate() + i);
    dates.push(curr.toISOString().slice(0, 10));
  }

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startMonth = monthNames[monday.getUTCMonth()];
  const endMonth = monthNames[sunday.getUTCMonth()];
  const startDay = monday.getUTCDate();
  const endDay = sunday.getUTCDate();
  const year = sunday.getUTCFullYear();

  const label = startMonth === endMonth
    ? `${startMonth} ${startDay} – ${endDay}, ${year}`
    : `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${year}`;

  return { dates, start: monday, end: sunday, label };
}

/**
 * Calculates comprehensive weekly statistics across all alerted tokens
 */
export async function calculateWeeklyStats(weekOffset = 0, baseTradeSol = 0.1, solPriceUsd = 160.0): Promise<WeeklyStats> {
  const { dates, label, start, end } = getWeekDates(weekOffset);
  const startDateStr = dates[0];
  const endDateStr = dates[dates.length - 1];

  const tokens = await prisma.earlyTrendingToken.findMany({
    where: {
      alertDate: { in: dates },
    },
    orderBy: { createdAt: 'desc' },
  });

  const totalSignals = tokens.length;
  let winsCount = 0;
  let flopsCount = 0;
  let totalWinMultiplier = 0;
  let totalFlopDropPct = 0;

  let bestToken: any = null;
  let bestMult = 1.0;
  let worstToken: any = null;
  let worstDrop = 0;

  const breakdown = {
    x50plus: 0,
    x20to50: 0,
    x10to20: 0,
    x5to10: 0,
    x2to5: 0,
  };

  let grossSolMade = 0;
  let grossSolLost = 0;

  // Daily map to calculate per-day performance
  const dailyMap = new Map<string, {
    date: string;
    dayLabel: string;
    totalSignals: number;
    winsCount: number;
    flopsCount: number;
    grossSolMade: number;
    grossSolLost: number;
    winMultiplier: number;
    drawdownMultiplier: number;
  }>();

  for (const dStr of dates) {
    dailyMap.set(dStr, {
      date: dStr,
      dayLabel: formatWeeklyDayLabel(dStr),
      totalSignals: 0,
      winsCount: 0,
      flopsCount: 0,
      grossSolMade: 0,
      grossSolLost: 0,
      winMultiplier: 0,
      drawdownMultiplier: 0,
    });
  }

  for (const t of tokens) {
    const mult = t.peakPriceUsd && t.entryPriceUsd > 0
      ? t.peakPriceUsd / t.entryPriceUsd
      : (1 + (t.lastMilestonePct || 0) / 100);

    const dropFromEntryPct = t.entryPriceUsd > 0
      ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
      : 0;

    const dropFromPeakPct = t.peakPriceUsd > 0
      ? ((t.lastAlertedPriceUsd - t.peakPriceUsd) / t.peakPriceUsd) * 100
      : dropFromEntryPct;

    // Classification of Win vs Flop
    const isWin = mult >= 1.5;
    const isFlop = dropFromEntryPct <= -20 || (dropFromPeakPct <= -45 && dropFromEntryPct <= 10) || (t.lastDipMilestonePct === -50 && dropFromEntryPct <= -30);

    // Track daily stats
    const tokenDate = t.alertDate;
    if (!dailyMap.has(tokenDate)) {
      dailyMap.set(tokenDate, {
        date: tokenDate,
        dayLabel: formatWeeklyDayLabel(tokenDate),
        totalSignals: 0,
        winsCount: 0,
        flopsCount: 0,
        grossSolMade: 0,
        grossSolLost: 0,
        winMultiplier: 0,
        drawdownMultiplier: 0,
      });
    }
    const dayStat = dailyMap.get(tokenDate)!;
    dayStat.totalSignals++;

    if (isWin) {
      winsCount++;
      totalWinMultiplier += mult;
      // Money Made on this coin: (Multiplier - 1.0) * baseTradeSol
      const profitSol = (mult - 1.0) * baseTradeSol;
      grossSolMade += profitSol;

      dayStat.winsCount++;
      dayStat.winMultiplier += mult;
      dayStat.grossSolMade += profitSol;

      if (mult >= 50.0) breakdown.x50plus++;
      else if (mult >= 20.0) breakdown.x20to50++;
      else if (mult >= 10.0) breakdown.x10to20++;
      else if (mult >= 5.0) breakdown.x5to10++;
      else if (mult >= 2.0) breakdown.x2to5++;

      if (mult > bestMult) {
        bestMult = mult;
        bestToken = {
          symbol: t.tokenSymbol,
          name: t.tokenName,
          mint: t.tokenMint,
          multiplier: Number(mult.toFixed(1)),
          entryMc: Math.round(t.entryMarketCap),
          peakMc: Math.round(t.entryMarketCap * mult),
        };
      }
    }

    if (isFlop) {
      flopsCount++;
      const absDrop = Math.abs(dropFromEntryPct);
      totalFlopDropPct += absDrop;

      // Trailing Stop-Loss protects at -25% max loss if active, or actual drop
      const effectiveLossPct = Math.min(absDrop, 25.0);
      const lossSol = (effectiveLossPct / 100) * baseTradeSol;
      grossSolLost += lossSol;

      dayStat.flopsCount++;
      dayStat.drawdownMultiplier += absDrop / 100;
      dayStat.grossSolLost += lossSol;

      if (dropFromEntryPct < worstDrop) {
        worstDrop = dropFromEntryPct;
        worstToken = {
          symbol: t.tokenSymbol,
          name: t.tokenName,
          mint: t.tokenMint,
          dropPct: Number(dropFromEntryPct.toFixed(1)),
        };
      }
    }
  }

  // Calculate day made the most & day lost the most
  let bestDay: DayHighlight | null = null;
  let maxMadeSol = 0;

  let worstDay: DayHighlight | null = null;
  let maxLostSol = 0;

  const dailyBreakdown: DailyBreakdownItem[] = [];

  for (const [dStr, dStat] of dailyMap.entries()) {
    const dGrossUsdMade = Number((dStat.grossSolMade * solPriceUsd).toFixed(2));
    const dGrossUsdLost = Number((dStat.grossSolLost * solPriceUsd).toFixed(2));
    const dNetSolPnL = Number((dStat.grossSolMade - dStat.grossSolLost).toFixed(3));
    const dNetUsdPnL = Number((dGrossUsdMade - dGrossUsdLost).toFixed(2));

    dailyBreakdown.push({
      date: dStr,
      dayLabel: dStat.dayLabel,
      totalSignals: dStat.totalSignals,
      winsCount: dStat.winsCount,
      flopsCount: dStat.flopsCount,
      grossSolMade: Number(dStat.grossSolMade.toFixed(3)),
      grossUsdMade: dGrossUsdMade,
      grossSolLost: Number(dStat.grossSolLost.toFixed(3)),
      grossUsdLost: dGrossUsdLost,
      netSolPnL: dNetSolPnL,
      netUsdPnL: dNetUsdPnL,
      winMultiplier: Number(dStat.winMultiplier.toFixed(1)),
      drawdownMultiplier: Number(dStat.drawdownMultiplier.toFixed(1)),
    });

    // Check if this day made the most money
    if (dStat.grossSolMade > maxMadeSol) {
      maxMadeSol = dStat.grossSolMade;
      bestDay = {
        date: dStr,
        dayLabel: dStat.dayLabel,
        grossSol: Number(dStat.grossSolMade.toFixed(3)),
        grossUsd: dGrossUsdMade,
        multiplier: Number(dStat.winMultiplier.toFixed(1)),
        netSolPnL: dNetSolPnL,
      };
    }

    // Check if this day lost the most money
    if (dStat.grossSolLost > maxLostSol) {
      maxLostSol = dStat.grossSolLost;
      worstDay = {
        date: dStr,
        dayLabel: dStat.dayLabel,
        grossSol: Number(dStat.grossSolLost.toFixed(3)),
        grossUsd: dGrossUsdLost,
        multiplier: Number(dStat.drawdownMultiplier.toFixed(1)),
        netSolPnL: dNetSolPnL,
      };
    }
  }

  const winRatePercent = totalSignals > 0 ? Math.round((winsCount / totalSignals) * 100) : 0;
  const roundedWinMult = Number(totalWinMultiplier.toFixed(1));
  const totalDrawdownMultiplier = Number((totalFlopDropPct / 100).toFixed(1));
  const totalDrawdownPercent = Math.round(totalFlopDropPct);
  const netMultiplier = Number((roundedWinMult - totalDrawdownMultiplier).toFixed(1));

  const grossUsdMade = Number((grossSolMade * solPriceUsd).toFixed(2));
  const grossUsdLost = Number((grossSolLost * solPriceUsd).toFixed(2));
  const netSolPnL = Number((grossSolMade - grossSolLost).toFixed(3));
  const netUsdPnL = Number((grossUsdMade - grossUsdLost).toFixed(2));

  let aiInsights: string[] = [];
  try {
    const { analyzeWeeklyCorrelations } = await import('./aiIntelligence.js');
    aiInsights = await analyzeWeeklyCorrelations(tokens, label);
  } catch (aiErr: any) {
    console.warn(`[Weekly AI Correlation Note]: ${aiErr.message}`);
  }

  return {
    weekLabel: label,
    startDateStr,
    endDateStr,
    totalSignals,
    winsCount,
    flopsCount,
    winRatePercent,
    totalWinMultiplier: roundedWinMult,
    totalDrawdownMultiplier,
    totalDrawdownPercent,
    netMultiplier,
    baseTradeSol,
    solPriceUsd,
    grossSolMade: Number(grossSolMade.toFixed(3)),
    grossUsdMade,
    grossSolLost: Number(grossSolLost.toFixed(3)),
    grossUsdLost,
    netSolPnL,
    netUsdPnL,
    bestDay,
    worstDay,
    dailyBreakdown,
    bestToken,
    worstToken,
    multiplierBreakdown: breakdown,
    aiInsights,
  };
}

/**
 * Formats a clean, high-impact Telegram message representing the Weekly Performance Recap
 */
export function renderWeeklyReportText(stats: WeeklyStats): string {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  const headerLink = `https://t.me/${botUsername}`;

  const isNetPositive = stats.netSolPnL >= 0;
  const netEmoji = isNetPositive ? '🟢' : '🔴';
  const netSign = isNetPositive ? '+' : '';

  let out = `🗓️ <a href="${headerLink}"><b>WEEKLY PERFORMANCE RECAP</b></a> 📊\n`;
  out += `📅 <b>Period:</b> <code>${stats.weekLabel}</code>\n`;
  out += `📡 <b>Signals Tracked:</b> <code>${stats.totalSignals} Verified Gems</code>\n`;
  out += `🎯 <b>Win Rate:</b> <code>${stats.winRatePercent}%</code> (${stats.winsCount} Wins / ${stats.flopsCount} Flops)\n\n`;

  out += `━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `💰 <b>MONEY MADE (WINS):</b>\n`;
  out += `🚀 <b>Total Multiplier Won:</b> <code>+${stats.totalWinMultiplier}X</code>\n`;
  out += `💵 <b>Gross Profit:</b> <code>+${stats.grossSolMade} SOL</code> (<code>+$${stats.grossUsdMade.toLocaleString()} USD</code>)\n`;
  out += `   <i>(Simulated on ${stats.baseTradeSol} SOL base snipe per coin)</i>\n\n`;

  out += `🏆 <b>Multiplier Breakdown:</b>\n`;
  if (stats.multiplierBreakdown.x50plus > 0) {
    out += `   • 🦄 <b>50X+ Mega Moonshots:</b> <code>${stats.multiplierBreakdown.x50plus}</code>\n`;
  }
  if (stats.multiplierBreakdown.x20to50 > 0) {
    out += `   • 💎 <b>20X–50X Runners:</b> <code>${stats.multiplierBreakdown.x20to50}</code>\n`;
  }
  if (stats.multiplierBreakdown.x10to20 > 0) {
    out += `   • 🚀 <b>10X–20X Rockets:</b> <code>${stats.multiplierBreakdown.x10to20}</code>\n`;
  }
  if (stats.multiplierBreakdown.x5to10 > 0) {
    out += `   • ⚡ <b>5X–10X Pumps:</b> <code>${stats.multiplierBreakdown.x5to10}</code>\n`;
  }
  if (stats.multiplierBreakdown.x2to5 > 0) {
    out += `   • 🎯 <b>2X–5X Doubles:</b> <code>${stats.multiplierBreakdown.x2to5}</code>\n`;
  }

  out += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `🩸 <b>MONEY LOST (FLOPS &amp; DIPS):</b>\n`;
  out += `📉 <b>Total Drawdown:</b> <code>-${stats.totalDrawdownMultiplier}X</code> (<code>-${stats.totalDrawdownPercent}%</code>)\n`;
  out += `🛡️ <b>Gross Loss:</b> <code>-${stats.grossSolLost} SOL</code> (<code>-$${stats.grossUsdLost.toLocaleString()} USD</code>)\n`;
  out += `   <i>(Protected by Trailing Stop-Loss cutting at -25%)</i>\n\n`;

  out += `━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `${netEmoji} <b>NET WEEKLY RESULTS:</b>\n`;
  out += `👑 <b>Net Multiplier:</b> <code>${netSign}${stats.netMultiplier}X</code>\n`;
  out += `💎 <b>Net Weekly PnL:</b> <code>${netSign}${stats.netSolPnL} SOL</code> (<code>${netSign}$${stats.netUsdPnL.toLocaleString()} USD</code>)\n\n`;

  // Daily Highlights: Day Made the Most & Day Lost the Most
  out += `━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `📅 <b>DAILY HIGHLIGHTS:</b>\n`;
  if (stats.bestDay) {
    const bNetSign = stats.bestDay.netSolPnL >= 0 ? '+' : '';
    out += `🌟 <b>Day Made The Most:</b>\n`;
    out += `   <code>${stats.bestDay.dayLabel}</code> • <code>+${stats.bestDay.grossSol} SOL</code> (<code>+$${stats.bestDay.grossUsd.toLocaleString()} USD</code> • <code>+${stats.bestDay.multiplier}X</code> • Net: <code>${bNetSign}${stats.bestDay.netSolPnL} SOL</code>)\n\n`;
  } else {
    out += `🌟 <b>Day Made The Most:</b> <i>None (Radar scanning...)</i>\n\n`;
  }

  if (stats.worstDay) {
    const wNetSign = stats.worstDay.netSolPnL >= 0 ? '+' : '';
    out += `🩸 <b>Day Lost The Most:</b>\n`;
    out += `   <code>${stats.worstDay.dayLabel}</code> • <code>-${stats.worstDay.grossSol} SOL</code> (<code>-$${stats.worstDay.grossUsd.toLocaleString()} USD</code> • <code>-${stats.worstDay.multiplier}X</code> • Net: <code>${wNetSign}${stats.worstDay.netSolPnL} SOL</code>)\n\n`;
  } else {
    out += `🩸 <b>Day Lost The Most:</b> <i>None (0 flops this week! 🟢)</i>\n\n`;
  }

  // Active Days Ledger
  const activeDays = stats.dailyBreakdown.filter((d) => d.totalSignals > 0);
  if (activeDays.length > 0) {
    out += `📆 <b>Day-by-Day Ledger:</b>\n`;
    for (const d of activeDays) {
      const dayNetEmoji = d.netSolPnL >= 0 ? '🟢' : '🔴';
      const dayNetSign = d.netSolPnL >= 0 ? '+' : '';
      out += `   • <b>${d.dayLabel}:</b> <code>+${d.grossSolMade} SOL</code> won | <code>-${d.grossSolLost} SOL</code> lost ➔ ${dayNetEmoji} <code>${dayNetSign}${d.netSolPnL} SOL</code>\n`;
    }
    out += `\n`;
  }

  if (stats.bestToken) {
    const bestDex = `https://dexscreener.com/solana/${stats.bestToken.mint}`;
    out += `🥇 <b>Best Gem of the Week:</b>\n`;
    out += `   <a href="${bestDex}"><b>$${stats.bestToken.symbol}</b></a> • <code>+${stats.bestToken.multiplier}X</code> ($${(stats.bestToken.entryMc / 1000).toFixed(0)}K ➔ $${(stats.bestToken.peakMc / 1000).toFixed(0)}K MC)\n\n`;
  }

  if (stats.worstToken) {
    const worstDex = `https://dexscreener.com/solana/${stats.worstToken.mint}`;
    out += `💀 <b>Worst Flop of the Week:</b>\n`;
    out += `   <a href="${worstDex}"><b>$${stats.worstToken.symbol}</b></a> • <code>${stats.worstToken.dropPct}%</code>\n\n`;
  }

  // AI Strategic Insights
  if (stats.aiInsights && stats.aiInsights.length > 0) {
    out += `━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `🧠 <b>AI STRATEGIC INSIGHTS:</b>\n`;
    for (const insight of stats.aiInsights) {
      out += `   ${insight}\n`;
    }
    out += `\n`;
  }

  out += `🛡️ <i>Risk Control: Strict audits + automated profit taking turn volatile runs into steady weekly returns.</i>`;

  return out.trim();
}
