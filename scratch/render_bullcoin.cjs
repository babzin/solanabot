function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatUsd(amount) {
  if (!amount || isNaN(amount)) return '$0';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

function getDexScreenerUrl(token) {
  if (token.dexUrl) return token.dexUrl;
  if (token.pairAddress) return `https://dexscreener.com/solana/${token.pairAddress}`;
  return `https://dexscreener.com/solana/${token.tokenMint}`;
}

function renderEarlyTrendingCardText(token) {
  const mint = token.tokenMint;
  const dexscreenerUrl = getDexScreenerUrl(token);

  const links = [];
  if (token.xUrl) links.push(`<a href="${token.xUrl}">X</a>`);
  if (token.webUrl) links.push(`<a href="${token.webUrl}">WEB</a>`);
  if (token.tgUrl) links.push(`<a href="${token.tgUrl}">TG</a>`);
  links.push(`<a href="${dexscreenerUrl}">CHART</a>`);
  const linksLine = links.join('•');

  const mc = token.entryMarketCap || token.marketCap || 50_000;
  const mcStr = formatUsd(mc);
  const peakVal = token.peakPriceUsd && token.entryPriceUsd && token.entryPriceUsd > 0
    ? Math.max(mc * 1.05, (token.peakPriceUsd / token.entryPriceUsd) * mc)
    : mc * 1.05;
  const peakStr = formatUsd(peakVal);

  const liqUsd = token.liquidityUsd || Math.round(mc * 0.35);
  const liqStr = formatUsd(liqUsd);
  const vol1h = token.volume1h || Math.round(mc * 0.28);
  const vol1hStr = formatUsd(vol1h);
  const devSol = token.whaleSolAmount ? Math.max(0, Math.round(token.whaleSolAmount)) : 0;
  const holderCount = token.holderCount || 393;
  const top20Pct = token.top20Pct || 30;
  const devHoldingPct = token.devHoldingPct || 0;
  const fishPct = Math.max(15, Math.round(top20Pct * 0.65));
  const whalePct = Math.max(5, Math.round(top20Pct - fishPct));
  const soldIcon = devHoldingPct === 0 ? '🟢' : '🔴';
  const burntPct = 100;

  let ageText = token.ageText;
  if (!ageText && token.pairCreatedAt) {
    const createdMs = Number(token.pairCreatedAt);
    const diffMin = Math.max(1, Math.floor((Date.now() - createdMs) / 60_000));
    ageText = `${diffMin}m`;
  } else if (!ageText && token.ageMinutes) {
    ageText = `${token.ageMinutes}m`;
  } else if (!ageText) {
    ageText = '3m';
  }

  return `
🔥 <a href="${dexscreenerUrl}"><b>${escapeHtml(token.tokenName || token.tokenSymbol)}</b></a><b> New </b><a href="https://t.me/solearlytrending"><b>Trending</b></a>
🕒 <b>Age</b>: ${ageText} | <b>Security</b>: ✅
🔗 ${linksLine}

💰 <b>MC: ${mcStr}</b> • 🔝 ${peakStr}
💧 <b>Liq:</b> ${liqStr}
📈 <b>Vol:</b> <i>1h</i>: ${vol1hStr}
┗   <b>Fake:</b> $0
👥 <a href="https://solscan.io/token/${mint}#holders"><b>Hodls:</b></a> ${holderCount}

📦 <b>/Bundles:</b> 0 • 0% → 0%
🔫 <b>Snipers:</b> 18 • 31% → 3.8% 🤍
<b>🎯 First 20:</b> ${top20Pct}% | 🐟 ${fishPct}% | 🐳 ${whalePct}%
🛠📦📦📦🐳🐟🐟🐟🍤🐟
🐟🐟🍤🐟🐟🐟🐟🍤🐟🐳

<b>🛠️ Dev:</b> ${devSol} SOL | ${devHoldingPct}%
┣ Bundled: 0% 🤍 | Sold: 0% ${soldIcon}
┗ Airdrops: 0% 🤍 | Burnt: ${burntPct}% 🔥
`.trim();
}

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
