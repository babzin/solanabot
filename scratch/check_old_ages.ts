import axios from 'axios';
import { prisma } from '../src/services/db.js';

async function checkOldAges() {
  const all = await prisma.earlyTrendingToken.findMany();
  for (const t of all) {
    try {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${t.tokenMint}`);
      const pair = res.data?.pairs?.[0];
      if (pair?.pairCreatedAt) {
        const ageHours = ((Date.now() - pair.pairCreatedAt) / 3600000).toFixed(1);
        console.log(`${t.tokenSymbol}: Real Age is ${ageHours} hours ago!`);
      } else {
        console.log(`${t.tokenSymbol}: No pairCreatedAt`);
      }
    } catch (e: any) {
      console.log(`${t.tokenSymbol}: error ${e.message}`);
    }
  }
}

checkOldAges().finally(() => prisma.$disconnect());
