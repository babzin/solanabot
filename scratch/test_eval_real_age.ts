import { scanEarlyTrendingCandidates, evaluate5xCandidates } from '../src/services/earlyTrending.js';

async function main() {
  console.log('Scanning candidates...');
  const mints = await scanEarlyTrendingCandidates();
  console.log(`Found ${mints.length} unique mints.`);
  
  const qualified = await evaluate5xCandidates(mints);
  console.log(`Qualified: ${qualified.length}`);
  for (const q of qualified) {
    console.log(`- ${q.tokenSymbol} (${q.tokenMint}) | Age: ${q.ageText} | MC: $${q.marketCap} | CreatedAt: ${q.pairCreatedAt}`);
  }
}

main().catch(console.error);
