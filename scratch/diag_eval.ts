import axios from 'axios';
import { scanEarlyTrendingCandidates } from '../src/services/earlyTrending.js';

async function diag() {
  const mints = await scanEarlyTrendingCandidates();
  console.log(`Scanning ${mints.length} mints...`);
  
  const chunk = mints.slice(0, 30);
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
  const pairs = res.data?.pairs || [];
  
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const symbol = p.baseToken?.symbol;
    const pairCreatedAt = p.pairCreatedAt;
    if (!pairCreatedAt) {
      console.log(`[REJECT] ${symbol}: No pairCreatedAt`);
      continue;
    }
    const ageMs = Date.now() - pairCreatedAt;
    const ageMin = Math.floor(ageMs / 60000);
    const mc = p.marketCap || p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    const vol1h = p.volume?.h1 || 0;
    const txns1h = p.txns?.h1 || p.txns?.m5 || { buys: 0, sells: 0 };
    const totalTxns = (txns1h.buys || 0) + (txns1h.sells || 0);

    console.log(`${symbol} | Age: ${ageMin}m | MC: $${mc.toFixed(0)} | Liq: $${liq.toFixed(0)} | Vol1h: $${vol1h.toFixed(0)} | Txns: ${totalTxns}`);
  }
}

diag().catch(console.error);
