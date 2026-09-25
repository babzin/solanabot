import axios from 'axios';
import { env } from '../src/config/env.js';

async function testGemini36Search(tokenQuery: string) {
  const apiKey = env.GEMINI_API_KEY;
  console.log('Testing gemini-3.6-flash with Google Search...');
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{
            text: `You are an elite crypto degen and memecoin researcher.
Search social media (X/Twitter), Reddit, and the internet for the Solana token: "${tokenQuery}".

Explain in detail:
1. What is the narrative and concept behind this coin? (lore, meme origins, pop culture reference, AI agent, utility, or movement)
2. What is the community/Twitter buzzing about regarding this coin?
3. What is the overall meta/category?

Keep it punchy, insightful, direct, and completely human like an experienced trader chatting on Telegram. Format in clean Telegram HTML.`
          }]
        }
      ],
      tools: [{ googleSearch: {} }]
    };

    const res = await axios.post(url, payload, { timeout: 12000 });
    console.log('\n--- SUCCESS ---');
    console.log(res.data?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (res.data?.candidates?.[0]?.groundingMetadata) {
      console.log('\nGrounding metadata queries:', res.data.candidates[0].groundingMetadata.webSearchQueries);
    }
  } catch (err: any) {
    console.log('Gemini 3.6 error:', err.response?.data?.error?.message || err.message);
  }
}

testGemini36Search('$NPC Solana Non Playable Coin');
