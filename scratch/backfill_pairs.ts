import axios from 'axios';
import { prisma } from '../src/services/db.js';

async function backfill() {
  console.log('🔄 Checking existing EarlyTrendingToken records for missing dexUrl / pairAddress...');
  const tokens = await prisma.earlyTrendingToken.findMany({
    where: {
      OR: [
        { dexUrl: null },
        { pairAddress: null },
      ],
    },
  });

  console.log(`Found ${tokens.length} tokens to backfill.`);
  if (tokens.length === 0) {
    console.log('All tokens already have dexUrl and pairAddress!');
    process.exit(0);
  }

  const mints = tokens.map((t) => t.tokenMint);
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const res = await axios.get<any>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SolanaCopyBot/1.0)' },
      });

      const pairs = res.data?.pairs || [];
      for (const token of tokens) {
        if (!chunk.includes(token.tokenMint)) continue;
        const matchingPairs = pairs.filter((p: any) => p.chainId === 'solana' && p.baseToken?.address === token.tokenMint);
        matchingPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const best = matchingPairs[0];

        if (best) {
          const canonicalDexUrl = best.url || (best.pairAddress ? `https://dexscreener.com/solana/${best.pairAddress}` : `https://dexscreener.com/solana/${token.tokenMint}`);
          await prisma.earlyTrendingToken.update({
            where: { id: token.id },
            data: {
              dexUrl: canonicalDexUrl,
              pairAddress: best.pairAddress || null,
            },
          });
          console.log(`✅ Updated ${token.tokenSymbol} -> ${canonicalDexUrl}`);
        } else {
          // If no pair found on DexScreener, fallback to pairAddress or tokenMint
          const fallback = `https://dexscreener.com/solana/${token.tokenMint}`;
          await prisma.earlyTrendingToken.update({
            where: { id: token.id },
            data: {
              dexUrl: fallback,
            },
          });
          console.log(`⚠️ No pair found on DexScreener for ${token.tokenSymbol}, set fallback -> ${fallback}`);
        }
      }
    } catch (err: any) {
      console.error('Batch backfill error:', err.message);
    }
  }

  console.log('🎉 Backfill completed!');
  process.exit(0);
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
