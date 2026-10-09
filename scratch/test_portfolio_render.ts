import { getPaperPortfolioSummary } from '../src/services/paperTrading.js';
import { escapeHtml } from '../src/services/telegram.js';

async function testPortfolioRender() {
  console.log('🧪 Testing Paper Portfolio Message Formatter...');

  const summary = await getPaperPortfolioSummary();
  const w = summary.wallet;

  const pnlSign = summary.totalPnlUsd >= 0 ? '+' : '';
  const pnlEmoji = summary.totalPnlUsd >= 0 ? '💸' : '🩸';
  const statusColor = summary.totalPnlUsd >= 0 ? '🟢' : '🔴';

  let msg = `
💼 <b>[PAPER TRADING: $100 LIVE PORTFOLIO]</b> ${pnlEmoji}
<i>100% Real Market Dynamics • Real Gas &amp; Slippage Deductions</i>

🏦 <b>NET EQUITY:</b> <b>$${summary.netWorthUsd.toFixed(2)} USD</b> (<code>${summary.netWorthSol.toFixed(4)} SOL</code>)
${statusColor} <b>Total PnL:</b> <b>${pnlSign}$${summary.totalPnlUsd.toFixed(2)} (${pnlSign}${summary.totalPnlPercent.toFixed(1)}%)</b>
💵 <b>Liquid Cash:</b> <code>$${w.liquidCashUsd.toFixed(2)} USD</code> (<code>${w.liquidCashSol.toFixed(4)} SOL</code>)
${(w.autoRefillCount && w.autoRefillCount > 0) ? `🔄 <b>Auto-Refills:</b> <b>${w.autoRefillCount} time${w.autoRefillCount === 1 ? '' : 's'}</b> (<code>+$${((w.totalRefilledUsd || 0)).toFixed(2)} USD</code> added on depletion)\n` : ''}🔒 <b>In Active Trades:</b> <code>$${w.totalInvestedUsd.toFixed(2)} USD</code>
⛽ <b>Total Real Gas Paid:</b> <code>-${w.totalFeesPaidSol.toFixed(4)} SOL</code> (<b>-$${w.totalFeesPaidUsd.toFixed(2)}</b>)
🎯 <b>Win Rate:</b> <b>${w.winRatePercent.toFixed(1)}%</b> (${w.winningTrades}W / ${w.losingTrades}L • ${w.totalTrades} Total)

📊 <b>ACTIVE POSITIONS (${summary.activePositions.length}/${w.maxConcurrentPositions}):</b>
`;

  if (summary.activePositions.length === 0) {
    msg += `<i>No active open positions right now. Standing by for radar gems!</i>\n`;
  } else {
    const sortedPositions = [...summary.activePositions].sort((a, b) => {
      const isMoonA = a.status === 'PARTIAL_TP_2X' ? 1 : 0;
      const isMoonB = b.status === 'PARTIAL_TP_2X' ? 1 : 0;
      if (isMoonA !== isMoonB) return isMoonB - isMoonA;
      const gainA = (a.currentPriceUsd - a.entryPriceUsd) / Math.max(0.00000001, a.entryPriceUsd);
      const gainB = (b.currentPriceUsd - b.entryPriceUsd) / Math.max(0.00000001, b.entryPriceUsd);
      return gainB - gainA;
    });

    const maxPositionsToShow = 15;
    let displayedCount = 0;

    for (const pos of sortedPositions) {
      if (displayedCount >= maxPositionsToShow) break;
      const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / Math.max(0.00000001, pos.entryPriceUsd)) * 100;
      const sign = gainPct >= 0 ? '+' : '';
      const badge = pos.status === 'PARTIAL_TP_2X' ? '🌙 MOONBAG' : '🟢 OPEN';
      const mult = (pos.currentPriceUsd / Math.max(0.00000001, pos.entryPriceUsd)).toFixed(2);
      const chartUrl = pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}`;
      
      const line = `• <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a> [${badge}]: <b>${sign}${gainPct.toFixed(1)}%</b> (<code>${mult}X</code>) • Peak: <b>${pos.peakMultiplier}X</b> (Pos: $${pos.investedUsd.toFixed(2)})\n`;

      if ((msg + line).length > 3400) {
        break;
      }
      msg += line;
      displayedCount++;
    }

    if (sortedPositions.length > displayedCount) {
      msg += `\n<i>... and ${sortedPositions.length - displayedCount} more active runner(s) (Total: ${summary.activePositions.length}/${w.maxConcurrentPositions} slots active)</i>\n`;
    }
  }

  msg += `\n🛡️ <i>Uncapped Trailing Runner System • Principal secured at 2X • Trailing Stop active.</i>`;
  if (w.autoRefillCount && w.autoRefillCount > 0) {
    msg += `\n💡 <i>Auto-refilled ${w.autoRefillCount} time${w.autoRefillCount === 1 ? '' : 's'} (+$${((w.totalRefilledUsd || 0)).toFixed(2)} USD) when depleted to enter all AI coins without interruption.</i>`;
  }

  const finalMsg = msg.trim();
  console.log(`Total active positions: ${summary.activePositions.length}`);
  console.log(`Generated message character length: ${finalMsg.length} characters (Telegram Limit: 4096)`);

  if (finalMsg.length > 4000) {
    throw new Error(`❌ Message is too long! ${finalMsg.length} chars`);
  }

  console.log(`✅ Message length is safe (${finalMsg.length} / 4096 chars).`);
  console.log('\n--- Message Preview ---\n' + finalMsg.slice(0, 500) + '\n...\n');
  process.exit(0);
}

testPortfolioRender().catch((err) => {
  console.error(err);
  process.exit(1);
});
