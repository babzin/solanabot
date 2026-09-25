import axios from 'axios';

async function testDuckDuckGo(query: string) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 5000
    });
    // extract snippets
    const matches = res.data.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/g) || [];
    const snippets = matches.slice(0, 4).map((m: string) => m.replace(/<[^>]+>/g, '').trim());
    console.log('--- DuckDuckGo Results for:', query, '---');
    console.log(snippets);
    return snippets;
  } catch (err: any) {
    console.log('DuckDuckGo error:', err.message);
    return [];
  }
}

async function testDexScreenerProfile(mint: string) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 4000 });
    const pair = res.data?.pairs?.[0];
    console.log('--- DexScreener Pair Info ---');
    console.log('DexId:', pair?.dexId);
    console.log('BaseToken:', pair?.baseToken);
    console.log('Info:', pair?.info);
    return pair?.info;
  } catch (err: any) {
    console.log('DexScreener error:', err.message);
  }
}

async function testGemini36(query: string, searchSnippets: string[]) {
  const { env } = await import('../src/config/env.js');
  const apiKey = env.GEMINI_API_KEY;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const prompt = `You are an elite crypto degen and memecoin researcher.
A trader asks about the narrative and lore for Solana token: "${query}".

Web and Social Media Search context:
${searchSnippets.join('\n---\n')}

Explain:
1. What is the narrative and concept behind this coin? (lore, meme origins, pop culture reference, AI agent, community movement)
2. What are people on Twitter/socials saying about it?
3. What is the general vibe / meta?

Keep it punchy, human, and direct like a real trader talking on Telegram. Format in clean Telegram HTML.`;

    const res = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 380 }
    }, { timeout: 7000 });

    console.log('\n--- GEMINI 3.6 FLASH NARRATIVE REPORT ---');
    console.log(res.data?.candidates?.[0]?.content?.parts?.[0]?.text);
  } catch (err: any) {
    console.log('Gemini 3.6 error:', err.response?.data?.error?.message || err.message);
  }
}

async function run() {
  const snippets = await testDuckDuckGo('NPC Non Playable Coin solana memecoin narrative twitter');
  await testDexScreenerProfile('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
  if (snippets.length > 0) {
    await testGemini36('$NPC', snippets);
  }
}

run();
