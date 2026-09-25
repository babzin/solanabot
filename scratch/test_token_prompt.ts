import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { env } from '../src/config/env.js';

const prisma = new PrismaClient();

async function lookupToken(query: string) {
  const clean = query.trim().replace(/^\$/, '');
  const isMint = /^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean);

  let dbToken: any = null;
  if (isMint) {
    dbToken = await prisma.earlyTrendingToken.findUnique({ where: { tokenMint: clean } });
  } else {
    dbToken = await prisma.earlyTrendingToken.findFirst({
      where: {
        OR: [
          { tokenSymbol: { equals: clean } },
          { tokenName: { contains: clean } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  let pair: any = null;
  try {
    const mintToFetch = dbToken ? dbToken.tokenMint : (isMint ? clean : null);
    if (mintToFetch) {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintToFetch}`, { timeout: 4000 });
      const solPairs = (res.data?.pairs?.filter((p: any) => p.chainId === 'solana') || [])
        .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      pair = solPairs[0] || null;
    } else {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(clean)}`, { timeout: 4000 });
      const solPairs = (res.data?.pairs?.filter((p: any) => p.chainId === 'solana') || [])
        .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      pair = solPairs[0] || null;
    }
  } catch (err: any) {
    console.warn('Error:', err.message);
  }

  if (!pair && !dbToken) return null;

  const mint = pair?.baseToken?.address || dbToken?.tokenMint || clean;
  const symbol = pair?.baseToken?.symbol || dbToken?.tokenSymbol || clean.toUpperCase();
  const name = pair?.baseToken?.name || dbToken?.tokenName || symbol;
  const priceUsd = pair ? parseFloat(pair.priceUsd) || 0 : (dbToken?.entryPriceUsd || 0);
  const marketCap = Math.round(pair?.marketCap || pair?.fdv || dbToken?.entryMarketCap || 50000);
  const liquidityUsd = Math.round(pair?.liquidity?.usd || (marketCap * 0.18));
  const volume24h = Math.round(pair?.volume?.h24 || 0);
  const priceChange24h = pair?.priceChange?.h24 ? parseFloat(pair.priceChange.h24) : 0;
  const priceChange1h = pair?.priceChange?.h1 ? parseFloat(pair.priceChange.h1) : 0;

  const buys5m = pair?.txns?.m5?.buys || 0;
  const sells5m = pair?.txns?.m5?.sells || 0;
  const total5m = buys5m + sells5m;
  const buyRatio = total5m > 0 ? Math.round((buys5m / total5m) * 100) : 50;

  const reasonsToBuy: string[] = [];
  if (buys5m > sells5m && buys5m >= 5) reasonsToBuy.push(`Strong 5m buy pressure: ${buys5m} buys vs ${sells5m} sells (${buyRatio}% buy ratio)`);
  if (liquidityUsd >= 15000 && liquidityUsd / (marketCap || 1) >= 0.12) reasonsToBuy.push(`Healthy liquidity backing ($${liquidityUsd.toLocaleString()} USD • ${Math.round((liquidityUsd/marketCap)*100)}% of MC) preventing sudden crash`);
  if (marketCap >= 30000 && marketCap <= 350000) reasonsToBuy.push(`Sweet-spot market cap ($${marketCap.toLocaleString()}) with room to run to $1M+ valuation`);
  if (dbToken && dbToken.lastMilestonePct >= 50) reasonsToBuy.push(`Bot-verified breakout runner (already confirmed +${dbToken.lastMilestonePct}% gain on radar)`);
  if (pair?.info?.socials && pair.info.socials.length >= 1) reasonsToBuy.push(`Verified community socials (Twitter/Telegram) active with community raid presence`);
  if (reasonsToBuy.length === 0) reasonsToBuy.push(`Active trading liquidity on ${pair?.dexId || 'Raydium'} with organic volume`);

  const reasonsNotToBuy: string[] = [];
  if (sells5m > buys5m && sells5m >= 5) reasonsNotToBuy.push(`Sell pressure dominant in last 5m: ${sells5m} sells vs ${buys5m} buys`);
  if (marketCap > 0 && liquidityUsd / marketCap < 0.08) reasonsNotToBuy.push(`Thin liquidity ratio (<8% of MC). Slippage and exit dumps will be punishing`);
  if (priceChange24h > 350) reasonsNotToBuy.push(`Chart is heavily extended (+${Math.round(priceChange24h)}% in 24h). High risk of violent pullback if buying top`);
  if (marketCap < 20000) reasonsNotToBuy.push(`Micro-cap under $20k MC carries higher risk of sudden dev abandonment or bonding curve stall`);
  if (!pair?.info?.socials || pair.info.socials.length === 0) reasonsNotToBuy.push(`No verified Twitter/Telegram attached to DEX pair. Higher risk of copycat clone`);
  if (reasonsNotToBuy.length === 0) reasonsNotToBuy.push(`Solana volatility: always enforce a strict -25% stop-loss`);

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

async function testPrompt(tokenData: any, question: string) {
  const prompt = `You are a sharp, experienced Solana memecoin and DEX trader chatting directly with a fellow trader in Telegram.

Tone & Personality:
- Be completely human, natural, direct, and conversational. Talk like a real, experienced trader texting on Telegram.
- NO robotic headers, briefing titles, or corporate lecture tone.
- Answer the user's question immediately in the first sentence.
- Give concrete reasons to buy and reasons NOT to buy based on the live data below.
- Keep it concise, punchy, and quick to read on mobile (under 160 words).
- Format using clean Telegram HTML (<b>, <code>, <i>, <a>). Do not use Markdown asterisks or backticks.

Live On-Chain Data:
- Token: $${tokenData.symbol} (${tokenData.name})
- Price: $${tokenData.priceUsd} (24h change: ${tokenData.priceChange24h}%, 1h change: ${tokenData.priceChange1h}%)
- Market Cap: $${tokenData.marketCap.toLocaleString()}
- Liquidity: $${tokenData.liquidityUsd.toLocaleString()}
- DEX: ${tokenData.dex}
- Reasons to Buy: ${tokenData.reasonsToBuy.join('; ')}
- Reasons NOT to Buy: ${tokenData.reasonsNotToBuy.join('; ')}

Trader asked: "${question}"`;

  const key = env.GEMINI_API_KEY;
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${key}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 380 },
    }
  );
  console.log(`\n================================`);
  console.log(`ANSWER FOR "${question}":`);
  console.log(res.data.candidates[0].content.parts[0].text);
}

async function run() {
  const npc = await lookupToken('NPC');
  if (npc) await testPrompt(npc, 'should I buy $NPC right now?');

  const bonk = await lookupToken('BONK');
  if (bonk) await testPrompt(bonk, 'tell me about $BONK and give me reasons to buy or not');
}
run();
