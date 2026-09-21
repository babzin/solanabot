import axios from 'axios';
import { evaluate5xCandidates } from '../src/services/earlyTrending.js';

async function testBullcoin() {
  const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=bullcoin');
  const pair = res.data.pairs.find((p: any) => p.chainId === 'solana' && p.baseToken.symbol === 'bullcoin');
  if (!pair) {
    console.log('Bullcoin not found');
    return;
  }
  const mint = pair.baseToken.address;
  console.log(`Found bullcoin: ${mint} | CreatedAt: ${pair.pairCreatedAt} | Age: ${Math.floor((Date.now() - pair.pairCreatedAt) / 60000)}m | MC: $${pair.marketCap} | Liq: $${pair.liquidity?.usd}`);
  const qualified = await evaluate5xCandidates([mint]);
  console.log('Qualified result:', qualified.length);
  if (qualified.length > 0) {
    console.log(qualified[0]);
  }
}

testBullcoin().catch(console.error);
