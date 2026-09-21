import { renderEarlyTrendingCardText, getDexScreenerUrl } from '../src/services/telegram.js';

const mockToken = {
  tokenMint: '9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump',
  pairAddress: '7Rnw9QqtF2HFM6tKAegLpe96n56jMctkotBTKSHXWBEq',
  dexUrl: 'https://dexscreener.com/solana/7rnw9qqtf2hfm6tkaeglpe96n56jmctkotbtkshxwbeq',
  tokenName: 'musebook.trade',
  tokenSymbol: 'musebook',
  entryMarketCap: 56200,
  entryPriceUsd: 0.0000562,
  liquidityUsd: 18800,
  volume1h: 15400,
  ageText: '2m',
  holderCount: 393,
  top20Pct: 30,
  devHoldingPct: 0,
  whaleSolAmount: 5,
};

console.log('=== 1. NEW TRENDING ALERT CARD (ONE BY ONE) ===');
console.log(renderEarlyTrendingCardText(mockToken));

const chartUrl = getDexScreenerUrl(mockToken);

console.log('\n=== 2. UPDATE CARD: TOKEN PUMPS (+50% / 2X) ===');
console.log(`
📈 <a href="${chartUrl}"><b>${mockToken.tokenSymbol}</b></a> is up <b>50%</b> 📈
from ⚡️ <a href="${chartUrl}">Entry Signal</a>

<b>$56.2K</b> —> <b>$84.3K</b> 💵

💸💸
`.trim());

console.log('\n=== 3. UPDATE CARD: TOKEN GOES DOWN (-50% RETRACEMENT) ===');
console.log(`
📉 <a href="${chartUrl}"><b>${mockToken.tokenSymbol}</b></a> is down <b>50%</b> 📉
from ⚡️ <a href="${chartUrl}">Peak Level</a>

<b>$84.3K</b> —> <b>$42.1K</b> 💵

🩸🩸
`.trim());
