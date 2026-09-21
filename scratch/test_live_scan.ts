import { scanEarlyTrendingCandidates, evaluate5xCandidates } from '../src/services/earlyTrending.js';
import { renderEarlyTrendingCardText } from '../src/services/telegram.js';

async function testScan() {
  console.log('Scanning for genuine early tokens (1m-15m)...');
  const mints = await scanEarlyTrendingCandidates();
  console.log(`Found ${mints.length} candidate mints from live streams.`);
  
  const qualified = await evaluate5xCandidates(mints);
  console.log(`Qualified tokens: ${qualified.length}`);
  for (const q of qualified) {
    console.log('\n----------------------------------------');
    console.log(`TOKEN: ${q.tokenSymbol} (${q.tokenMint}) | Real Age: ${q.ageText}`);
    console.log(`CreatedAt: ${new Date(q.pairCreatedAt!).toISOString()}`);
    console.log(`MC: $${q.marketCap.toFixed(0)} | Liq: $${q.liquidityUsd.toFixed(0)} | Vol 1h: $${q.volume1h.toFixed(0)}`);
    console.log('\n--- RENDERED CARD ---');
    console.log(renderEarlyTrendingCardText(q));
  }
}

testScan()
  .catch(console.error)
  .finally(() => process.exit(0));
