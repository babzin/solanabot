import axios from 'axios';

async function checkFreshPairs() {
  console.log('Fetching latest token profiles and boosts from DexScreener...');
  
  const mints = new Set<string>();
  
  try {
    const resProfiles = await axios.get<any[]>('https://api.dexscreener.com/token-profiles/latest/v1');
    resProfiles.data.filter(t => t.chainId === 'solana' && t.tokenAddress).forEach(t => mints.add(t.tokenAddress));
  } catch (e: any) {
    console.error('Error fetching profiles:', e.message);
  }

  try {
    const resBoosts = await axios.get<any[]>('https://api.dexscreener.com/token-boosts/latest/v1');
    resBoosts.data.filter(t => t.chainId === 'solana' && t.tokenAddress).forEach(t => mints.add(t.tokenAddress));
  } catch (e: any) {
    console.error('Error fetching boosts:', e.message);
  }

  console.log(`Found ${mints.size} unique candidate mints. Querying pair details...`);

  const mintArray = Array.from(mints).slice(0, 30);
  const resPairs = await axios.get<any>(`https://api.dexscreener.com/latest/dex/tokens/${mintArray.join(',')}`);
  
  const pairs = resPairs.data?.pairs || [];
  console.log(`Received ${pairs.length} pairs. Checking creation timestamps:`);

  const now = Date.now();
  let freshCount = 0;

  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const createdAt = p.pairCreatedAt;
    if (!createdAt) continue;
    const ageMs = now - createdAt;
    const ageMin = Math.floor(ageMs / 60_000);
    const ageSec = Math.floor((ageMs % 60_000) / 1000);
    const symbol = p.baseToken?.symbol || 'UNKNOWN';
    const mc = p.marketCap || p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    
    console.log(`• $${symbol} | Age: ${ageMin}m ${ageSec}s | MC: $${Math.round(mc)} | Liq: $${Math.round(liq)} | URL: ${p.url}`);

    if (ageMin >= 1 && ageMin <= 15) {
      freshCount++;
    }
  }

  console.log(`\nTokens strictly between 1m and 15m old: ${freshCount}`);
}

checkFreshPairs().catch(console.error);
