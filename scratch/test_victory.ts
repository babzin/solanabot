import axios from 'axios';
import { verifyTokenSecurity } from '../src/services/security.js';
import { KNOWN_PROGRAMS } from '../src/config/strategies.js';

async function testVictory() {
  // VICTORY token address
  const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=VICTORY');
  const pair = res.data.pairs.find((p: any) => p.chainId === 'solana' && p.baseToken.symbol === 'VICTORY');
  if (!pair) {
    console.log('Pair not found');
    return;
  }
  const mint = pair.baseToken.address;
  console.log(`Testing VICTORY (${mint})...`);
  const sec = await verifyTokenSecurity(mint, KNOWN_PROGRAMS.RAYDIUM_AMM_V4);
  console.log('Security result:', {
    passed: sec.passed,
    reasons: sec.reasons,
    score: sec.score,
    mintAuthorityRevoked: sec.mintAuthorityRevoked,
    freezeAuthorityRevoked: sec.freezeAuthorityRevoked,
    lpBurnedOrLocked: sec.lpBurnedOrLocked,
    top20: sec.analytics?.top20HoldPct,
    devHolding: sec.analytics?.devHoldingPct,
  });
}

testVictory().catch(console.error);
