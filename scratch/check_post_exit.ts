import axios from 'axios';

async function check() {
  const portRes = await axios.get('http://localhost:3001/api/paper/portfolio');
  const closed = portRes.data.closedPositions || [];
  const mints = closed.map((p: any) => p.tokenMint).slice(0, 10);
  
  if (mints.length === 0) {
    console.log('No closed positions to check.');
    return;
  }

  const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`);
  const pairs = dexRes.data.pairs || [];

  console.log('\n--- PERFORMANCE AFTER BOT CLOSED IN LOSS ---');
  for (const pos of closed.slice(0, 10)) {
    const pair = pairs.find((p: any) => p.baseToken?.address === pos.tokenMint);
    const nowPrice = parseFloat(pair?.priceUsd || '0');
    const exitPrice = pos.currentPriceUsd;
    const changeAfterExit = exitPrice > 0 ? (((nowPrice - exitPrice) / exitPrice) * 100).toFixed(1) : 'N/A';
    const totalGainFromEntry = (((nowPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1);
    console.log(
      `$${pos.tokenSymbol.padEnd(10)} | Exit Reason: ${pos.exitReason.padEnd(14)} | Exit Price: $${exitPrice} | Current: $${nowPrice} | Gain Since Bot Sold: +${changeAfterExit}% | ATH Multiplier: ${pos.peakMultiplier}X`
    );
  }
}

check();
