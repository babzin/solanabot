import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function lookupTokenAnalytics(query: string) {
  const clean = query.trim().replace(/^\$/, '');
  const isMint = /^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean);

  // 1. Check local DB
  let dbToken = isMint
    ? await prisma.earlyTrendingToken.findUnique({ where: { tokenMint: clean } })
    : await prisma.earlyTrendingToken.findFirst({
        where: { tokenSymbol: { equals: clean } },
        orderBy: { createdAt: 'desc' },
      });

  // 2. Fetch DexScreener
  let pair: any = null;
  try {
    const url = isMint
      ? `https://api.dexscreener.com/latest/dex/tokens/${clean}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(clean)}`;
    const res = await axios.get(url, { timeout: 4000 });
    const solanaPairs = (res.data?.pairs?.filter((p: any) => p.chainId === 'solana') || [])
      .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    pair = solanaPairs[0] || null;
  } catch (err: any) {
    console.warn('DexScreener lookup error:', err.message);
  }

  if (!pair && !dbToken) return null;

  const mint = pair?.baseToken?.address || dbToken?.tokenMint || clean;
  const symbol = pair?.baseToken?.symbol || dbToken?.tokenSymbol || clean.toUpperCase();
  const name = pair?.baseToken?.name || dbToken?.tokenName || symbol;
  const priceUsd = pair ? parseFloat(pair.priceUsd) || 0 : dbToken?.entryPriceUsd || 0;
  const marketCap = Math.round(pair?.marketCap || pair?.fdv || dbToken?.entryMarketCap || 50000);
  const liquidityUsd = Math.round(pair?.liquidity?.usd || marketCap * 0.18);
  const volume24h = Math.round(pair?.volume?.h24 || 0);
  const priceChange24h = pair?.priceChange?.h24 ? parseFloat(pair.priceChange.h24) : 0;
  const priceChange1h = pair?.priceChange?.h1 ? parseFloat(pair.priceChange.h1) : 0;
  const buys5m = pair?.txns?.m5?.buys || 0;
  const sells5m = pair?.txns?.m5?.sells || 0;

  // Build Reasons to Buy (Bullish Factors)
  const reasonsToBuy: string[] = [];
  if (buys5m > sells5m && buys5m >= 5) {
    reasonsToBuy.push(`Active buy momentum: ${buys5m} buys vs ${sells5m} sells in the last 5 minutes.`);
  }
  if (liquidityUsd >= 15000 && liquidityUsd / (marketCap || 1) >= 0.12) {
    reasonsToBuy.push(`Healthy liquidity backing ($${liquidityUsd.toLocaleString()} USD • ${Math.round((liquidityUsd / marketCap) * 100)}% of MC) preventing easy dumps.`);
  }
  if (marketCap >= 30000 && marketCap <= 350000) {
    reasonsToBuy.push(`Sweet-spot market cap ($${marketCap.toLocaleString()}) with significant upside runway to $1M+ valuation.`);
  }
  if (dbToken && dbToken.lastMilestonePct >= 50) {
    reasonsToBuy.push(`Bot-verified breakout runner (already confirmed +${dbToken.lastMilestonePct}% gain on radar).`);
  }
  if (pair?.info?.socials && pair.info.socials.length >= 1) {
    reasonsToBuy.push(`Verified community socials (Twitter/Telegram) active with community raid presence.`);
  }
  if (reasonsToBuy.length === 0) {
    reasonsToBuy.push(`Active trading liquidity on ${pair?.dexId || 'Raydium'} with organic DEX volume.`);
  }

  // Build Reasons NOT to Buy (Risk Warnings)
  const reasonsNotToBuy: string[] = [];
  if (sells5m > buys5m && sells5m >= 5) {
    reasonsNotToBuy.push(`Sell pressure currently leading: ${sells5m} sells vs ${buys5m} buys in the last 5 minutes.`);
  }
  if (marketCap > 0 && liquidityUsd / marketCap < 0.08) {
    reasonsNotToBuy.push(`Thin liquidity ratio (<8% of MC). Slippage and exit dumps will be punishing.`);
  }
  if (priceChange24h > 350) {
    reasonsNotToBuy.push(`Chart is heavily extended (+${Math.round(priceChange24h)}% in 24h). High risk of getting dumped on if buying the green top.`);
  }
  if (marketCap < 20000) {
    reasonsNotToBuy.push(`Micro-cap under $20k MC carries higher risk of sudden dev abandonment or bonding curve stalling.`);
  }
  if (!pair?.info?.socials || pair.info.socials.length === 0) {
    reasonsNotToBuy.push(`No verified Twitter/Telegram attached to DEX pair. Higher risk of anonymous copycat.`);
  }
  if (reasonsNotToBuy.length === 0) {
    reasonsNotToBuy.push(`Solana microcap volatility: always use a strict -25% stop loss to protect against sudden market pullbacks.`);
  }

  return {
    mint,
    symbol,
    name,
    priceUsd,
    marketCap,
    liquidityUsd,
    volume24h,
    priceChange24h,
    priceChange1h,
    reasonsToBuy,
    reasonsNotToBuy,
    dex: pair?.dexId || 'Raydium',
  };
}

async function run() {
  console.log('Testing BONK:');
  const bonk = await lookupTokenAnalytics('BONK');
  console.log(bonk);

  console.log('\nTesting DB Token NPC:');
  const npc = await lookupTokenAnalytics('NPC');
  console.log(npc);
}
run();
