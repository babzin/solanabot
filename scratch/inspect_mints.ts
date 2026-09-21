import axios from 'axios';
import { scanEarlyTrendingCandidates } from '../src/services/earlyTrending.js';

async function inspectMints() {
  const mints = await scanEarlyTrendingCandidates();
  console.log(`Checking ${mints.length} candidate mints...`);
  
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(0, 30).join(',')}`);
  const pairs = res.data?.pairs || [];
  
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const symbol = p.baseToken?.symbol;
    const createdAt = p.pairCreatedAt;
    if (!createdAt) {
      console.log(`${symbol}: No pairCreatedAt`);
      continue;
    }
    const ageMin = Math.floor((Date.now() - createdAt) / 60000);
    const mc = p.marketCap || p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    console.log(`${symbol} | Age: ${ageMin}m | MC: $${mc.toFixed(0)} | Liq: $${liq.toFixed(0)} | Txns: ${(p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0)}`);
  }
}

inspectMints().catch(console.error);
