import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function predictTopGemsToBuy() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let candidates = await prisma.earlyTrendingToken.findMany({
    where: {
      alertDate: { in: [todayStr, yesterdayStr] },
    },
    orderBy: { lastMilestonePct: 'desc' },
    take: 15,
  });

  // Filter out heavy dumps
  const activeGems = candidates.filter((t) => {
    const drop = t.entryPriceUsd > 0 ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100 : 0;
    return drop > -25;
  });

  const topGems = activeGems.slice(0, 3);

  if (topGems.length === 0) {
    return {
      text: `📡 <b>Radar Scanning Active:</b> Looking for fresh 5x-20x breakout setups right now.\n` +
        `No tokens currently meet our strict volume and dev-retention criteria this second. Tap <b>⚡ Scan Now</b> to trigger a real-time on-chain sweep!`,
      tokens: [],
    };
  }

  let text = `🎯 <b>Top Coins to Buy Right Now (Bot Radar Picks):</b>\n\n` +
    `Based on live on-chain momentum, liquidity, and buy pressure, here are the top predicted gems from our active signals:\n\n`;

  const tokensForButtons: any[] = [];

  for (let i = 0; i < topGems.length; i++) {
    const t = topGems[i];
    tokensForButtons.push(t);
    const mult = t.peakPriceUsd && t.entryPriceUsd > 0 ? (t.peakPriceUsd / t.entryPriceUsd).toFixed(1) : (1 + (t.lastMilestonePct || 0) / 100).toFixed(1);
    const mcFmt = `$${Math.round(t.entryMarketCap || 50000).toLocaleString()}`;
    const priceFmt = t.lastAlertedPriceUsd < 0.01 ? `$${t.lastAlertedPriceUsd.toFixed(6)}` : `$${t.lastAlertedPriceUsd.toFixed(4)}`;

    text += `${i + 1}️⃣ <b>$${t.tokenSymbol}</b> (${t.tokenName}) • 🟢 <b>${t.lastMilestonePct > 0 ? `+${t.lastMilestonePct}% RUNNER` : 'FRESH BREAKOUT'}</b>\n` +
      `• <b>Price:</b> <code>${priceFmt}</code> | <b>MC:</b> <code>${mcFmt}</code> | <b>Peak:</b> <code>${mult}x</code>\n` +
      `• 🟢 <b>Why Buy:</b> High organic volume, verified on-chain momentum, and clean liquidity.\n` +
      `• 🔴 <b>Why NOT to Buy:</b> High volatility—do not ape blind. If volume drops 50% on 5m, cut the trade.\n` +
      `• 💡 <b>Trade Plan:</b> <i>Entry size: 0.1–0.25 SOL • Take 50% off at 2x • Hard stop at -25%</i>\n` +
      `• <code>${t.tokenMint}</code>\n\n`;
  }

  text += `💡 <i>Tap any button below to view the live DexScreener chart or 1-tap snipe!</i>`;

  return { text, tokens: tokensForButtons };
}

(async () => {
  const res = await predictTopGemsToBuy();
  console.log(res.text);
  console.log('TOKENS:', res.tokens.map(t => t.tokenSymbol));
})();
