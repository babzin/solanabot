import { PaperPosition } from '../src/services/paperTrading.js';
import { escapeHtml } from '../src/services/telegram.js';

function testMaxPositionsFormatting() {
  console.log('🧪 Testing with 50 synthetic open positions...');

  const syntheticPositions: PaperPosition[] = [];
  for (let i = 1; i <= 50; i++) {
    syntheticPositions.push({
      id: `pos_${i}`,
      tokenMint: `Mint_${i}_1111111111111111111111111111111`,
      tokenSymbol: `COIN_${i}`,
      tokenName: `Coin Long Name ${i}`,
      entryPriceUsd: 0.000123,
      currentPriceUsd: 0.000246 * (1 + i * 0.1),
      peakPriceUsd: 0.000300 * (1 + i * 0.1),
      lowestPriceUsd: 0.000100,
      investedUsd: 2.50,
      investedSol: 0.017,
      tokensAcquired: 20000,
      slippagePct: 2.5,
      buyGasFeeSol: 0.0035,
      buyGasFeeUsd: 0.38,
      status: i % 3 === 0 ? 'PARTIAL_TP_2X' : 'OPEN',
      initialTokens: 20000,
      remainingTokens: i % 3 === 0 ? 10000 : 20000,
      realizedPnlUsd: i % 3 === 0 ? 2.50 : 0,
      realizedSolProfit: 0.017,
      openedAt: Date.now() - 3600000,
      dexUrl: `https://dexscreener.com/solana/Mint_${i}`,
      peakMultiplier: 2.5 + i * 0.2,
    });
  }

  let msg = `
💼 <b>[PAPER TRADING: $100 LIVE PORTFOLIO]</b> 💸
<i>100% Real Market Dynamics • Real Gas &amp; Slippage Deductions</i>

🏦 <b>NET EQUITY:</b> <b>$135.50 USD</b> (<code>0.9234 SOL</code>)
🟢 <b>Total PnL:</b> <b>+$35.50 (+35.5%)</b>
💵 <b>Liquid Cash:</b> <code>$48.27 USD</code> (<code>0.3329 SOL</code>)
🔄 <b>Auto-Refills:</b> <b>1 time</b> (<code>+$50.00 USD</code> added on depletion)
🔒 <b>In Active Trades:</b> <b>$87.23 USD</b>
⛽ <b>Total Real Gas Paid:</b> <code>-0.1250 SOL</code> (<b>-$13.75</b>)
🎯 <b>Win Rate:</b> <b>78.5%</b> (22W / 6L • 28 Total)

📊 <b>ACTIVE POSITIONS (50/200):</b>
`;

  const sortedPositions = [...syntheticPositions].sort((a, b) => {
    const isMoonA = a.status === 'PARTIAL_TP_2X' ? 1 : 0;
    const isMoonB = b.status === 'PARTIAL_TP_2X' ? 1 : 0;
    if (isMoonA !== isMoonB) return isMoonB - isMoonA;
    const gainA = (a.currentPriceUsd - a.entryPriceUsd) / a.entryPriceUsd;
    const gainB = (b.currentPriceUsd - b.entryPriceUsd) / b.entryPriceUsd;
    return gainB - gainA;
  });

  const maxPositionsToShow = 15;
  let displayedCount = 0;

  for (const pos of sortedPositions) {
    if (displayedCount >= maxPositionsToShow) break;
    const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const sign = gainPct >= 0 ? '+' : '';
    const badge = pos.status === 'PARTIAL_TP_2X' ? '🌙 MOONBAG' : '🟢 OPEN';
    const mult = (pos.currentPriceUsd / pos.entryPriceUsd).toFixed(2);
    const chartUrl = pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}`;
    
    const line = `• <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a> [${badge}]: <b>${sign}${gainPct.toFixed(1)}%</b> (<code>${mult}X</code>) • Peak: <b>${pos.peakMultiplier}X</b> (Pos: $${pos.investedUsd.toFixed(2)})\n`;

    if ((msg + line).length > 3400) {
      break;
    }
    msg += line;
    displayedCount++;
  }

  if (sortedPositions.length > displayedCount) {
    msg += `\n<i>... and ${sortedPositions.length - displayedCount} more active runner(s) (Total: ${syntheticPositions.length}/200 slots active)</i>\n`;
  }

  msg += `\n🛡️ <i>Uncapped Trailing Runner System • Principal secured at 2X • Trailing Stop active.</i>`;
  msg += `\n💡 <i>Auto-refilled 1 time (+$50.00 USD) when depleted to enter all AI coins without interruption.</i>`;

  const finalMsg = msg.trim();
  console.log(`Displayed count: ${displayedCount} / 50`);
  console.log(`Final message length: ${finalMsg.length} chars (Telegram limit is 4096)`);

  if (finalMsg.length > 4000) {
    throw new Error('❌ Message exceeded 4000 characters!');
  }
  console.log('✅ 50-position message test PASSED! Length is strictly contained within safe limit.');
  process.exit(0);
}

testMaxPositionsFormatting();
