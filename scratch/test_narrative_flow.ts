import axios from 'axios';
import { env } from '../src/config/env.js';

async function fetchTokenWebAndSocialIntelligence(websiteUrl?: string, socials?: any[], mint?: string) {
  let websiteTitle = '';
  let websiteDescription = '';
  let websiteTextSnippet = '';
  let twitterUrl = '';
  let twitterHandle = '';
  let telegramUrl = '';

  if (socials && Array.isArray(socials)) {
    for (const s of socials) {
      if (s.type === 'twitter' || s.url?.includes('x.com') || s.url?.includes('twitter.com')) {
        twitterUrl = s.url;
        const match = s.url.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i);
        if (match) twitterHandle = `@${match[1]}`;
      } else if (s.type === 'telegram' || s.url?.includes('t.me')) {
        telegramUrl = s.url;
      }
    }
  }

  if (websiteUrl) {
    try {
      const res = await axios.get(websiteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 4000,
      });

      const titleMatch = res.data.match(/<title[^>]*>(.*?)<\/title>/i);
      if (titleMatch) websiteTitle = titleMatch[1].replace(/<[^>]+>/g, '').trim();

      const descMatch = res.data.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                        res.data.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
                        res.data.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
      if (descMatch) websiteDescription = descMatch[1].trim();

      const bodyText = res.data
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      websiteTextSnippet = bodyText.slice(0, 1000);
    } catch (err: any) {
      console.warn(`[Website fetch notice for ${websiteUrl}]:`, err.message);
    }
  }

  const parts: string[] = [];
  if (websiteUrl) parts.push(`• Official Website: ${websiteUrl}`);
  if (websiteTitle) parts.push(`• Website Title: ${websiteTitle}`);
  if (websiteDescription) parts.push(`• Website Description / Tagline: "${websiteDescription}"`);
  if (websiteTextSnippet) parts.push(`• Website Project Text Preview:\n"${websiteTextSnippet.slice(0, 600)}..."`);
  if (twitterHandle) parts.push(`• Official Twitter/X: ${twitterHandle} (${twitterUrl})`);
  if (telegramUrl) parts.push(`• Official Telegram: ${telegramUrl}`);

  return parts.length > 0 ? parts.join('\n') : '• No official website or socials attached to DEX pair.';
}

async function testFullNarrativeFlow(query: string, userQuestion: string) {
  const { lookupTokenAnalytics } = await import('../src/services/aiIntelligence.js');
  const audit = await lookupTokenAnalytics(query);
  if (!audit) {
    console.log('Token not found:', query);
    return;
  }

  // Fetch DexScreener pair to get socials/websites
  let pairInfo: any = null;
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${audit.mint}`, { timeout: 4000 });
    pairInfo = res.data?.pairs?.find((p: any) => p.chainId === 'solana')?.info;
  } catch {}

  const webContext = await fetchTokenWebAndSocialIntelligence(
    pairInfo?.websites?.[0]?.url,
    pairInfo?.socials,
    audit.mint
  );

  const prompt = `You are a sharp, seasoned Solana memecoin and crypto narrative researcher chatting directly with a fellow trader on Telegram.
The user is asking: "${userQuestion}"

Token: $${audit.symbol} (${audit.name})
Mint: ${audit.mint}
Market Cap: $${audit.onChainMetrics.marketCapUsd.toLocaleString()} | Price: $${audit.onChainMetrics.priceUsd} (24h: ${audit.priceChange24h || 0}%)
DEX: ${audit.dexId || 'Raydium'}

LIVE INTERNET & SOCIAL MEDIA SCRAPED INTELLIGENCE:
${webContext}

Explain in detail:
1. 📖 The Lore & Meme Origin: Where did it come from? What meme, cultural moment, AI agent, or concept is it based on?
2. 🚀 The Core Narrative / Meta: Why are people buying it? What is the project actually trying to do or represent?
3. 💬 Social Sentiment & Twitter Vibe: What is the community buzz on Crypto Twitter and Telegram?
4. 💡 Trader's Verdict: Is this a sticky narrative with real viral legs, or just a quick short-lived copycat?

Tone & Style:
- Be completely human, punchy, conversational, and direct. Talk like a real trench trader on Telegram.
- No corporate lecture or cheesy robotic intro.
- Use clean Telegram HTML (<b>, <i>, <code>). Keep it engaging, clear, and informative (around 140-200 words).`;

  const models = ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-flash-latest'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const res = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 400 },
        },
        { timeout: 7000 }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        console.log(`\n================================`);
        console.log(`NARRATIVE REPORT FOR "${query}":`);
        console.log(text);
        return;
      }
    } catch {}
  }
}

async function run() {
  await testFullNarrativeFlow('NPC', 'what is the narrative of $NPC?');
  await testFullNarrativeFlow('UNTXD', 'tell me about $UNTXD narrative and social vibe');
}

run();
