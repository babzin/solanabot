import axios from 'axios';

async function testFreshness() {
  console.log('Testing DexScreener freshness...');
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 5000 });
    const solTokens = res.data.filter((t: any) => t.chainId === 'solana');
    console.log(`Found ${solTokens.length} solana token profiles.`);
    
    // Check first 10
    const mints = solTokens.slice(0, 15).map((t: any) => t.tokenAddress);
    const pairsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`);
    const pairs = pairsRes.data?.pairs || [];
    
    for (const p of pairs) {
      if (!p.pairCreatedAt) continue;
      const ageMin = Math.floor((Date.now() - p.pairCreatedAt) / 60000);
      console.log(`Token: ${p.baseToken?.symbol} (${p.baseToken?.address}) | Age: ${ageMin}m | CreatedAt: ${new Date(p.pairCreatedAt).toISOString()} | MC: $${p.marketCap}`);
    }
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

testFreshness();
