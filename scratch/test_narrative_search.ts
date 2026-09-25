import axios from 'axios';
import { env } from '../src/config/env.js';

async function testGeminiSearch(query: string) {
  const apiKey = env.GEMINI_API_KEY;
  const models = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];

  for (const model of models) {
    try {
      console.log(`Testing model ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `Search social media, Twitter, and the web for the Solana memecoin / cryptocurrency "${query}". What is its narrative, lore, meme origin, and what is the community buzzing about? Keep it punchy and concise.` }]
          }
        ],
        tools: [{ googleSearch: {} }]
      };

      const res = await axios.post(url, payload, { timeout: 10000 });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const grounding = res.data?.candidates?.[0]?.groundingMetadata;
      console.log(`\nSUCCESS with ${model}:`);
      console.log(text);
      if (grounding?.webSearchQueries) {
        console.log('Search queries executed:', grounding.webSearchQueries);
      }
      return text;
    } catch (err: any) {
      console.log(`Model ${model} error:`, err.response?.data?.error?.message || err.message);
    }
  }
}

async function testPumpFunMetadata(mint: string) {
  try {
    const res = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 3500 });
    console.log('\n--- Pump.fun Coin Data ---');
    console.log('Name:', res.data.name, 'Symbol:', res.data.symbol);
    console.log('Description:', res.data.description);
    console.log('Twitter:', res.data.twitter);
    console.log('Telegram:', res.data.telegram);
    console.log('Website:', res.data.website);
  } catch (err: any) {
    console.log('Pump.fun fetch notice:', err.message);
  }
}

async function run() {
  await testGeminiSearch('NPC solana coin');
  await testPumpFunMetadata('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
}

run();
