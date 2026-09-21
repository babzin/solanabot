import { renderEarlyTrendingCardText } from '../src/services/telegram.js';

const candidate = {
  tokenMint: '94jwPm2zZUoMmz7gciMyqGubfsmub9Z4MUzs6WuFpump',
  pairAddress: '96WopUR8tPBR8xqZdTKBvjU6hkU5UF6beRC6TKyMu6hW',
  tokenName: 'bullcoin',
  tokenSymbol: 'bullcoin',
  priceUsd: 0.00004816,
  marketCap: 48165,
  target5xMarketCap: 240825,
  target20xMarketCap: 963300,
  liquidityUsd: 17400.27,
  volume1h: 25371.9,
  ageText: '7m',
  ageMinutes: 7,
  imageUrl: 'https://cdn.dexscreener.com/cms/images/FZF4WkJaGXEKTAC0?width=800&height=800&quality=95&format=auto',
  dexUrl: 'https://dexscreener.com/solana/96wopur8tpbr8xqzdtkbvju6hku5uf6berc6tkymu6hw',
  pairCreatedAt: 1789929746000,
  whaleSolAmount: 2.5,
  holderCount: 80,
  top20Pct: 37,
  devHoldingPct: 0,
  xUrl: 'https://x.com/bullcoinpumpx',
};

console.log('=== EXACT RENDERED CARD ===\n');
console.log(renderEarlyTrendingCardText(candidate));
console.log('\n==========================');
